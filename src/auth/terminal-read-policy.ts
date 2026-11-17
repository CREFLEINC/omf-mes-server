import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';
import { IN_SERVICE, NEIGHBOR_EQUIPMENT } from './terminal-production-scope';

/** POP 이 끝난(완료·마감) W/O 를 읽을 수 있는 `updatedSince` 의 한계 — 48시간(공장 하루 + 여유). */
const RECENT_FINISHED_MS = 48 * 3_600_000;

/** 단말 시계가 서버보다 조금 빠를 수 있다 — 자정 직후 「오늘 0시」가 미래로 읽혀 막히지 않게 5분을 봐준다. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** `updatedSince` 가 지금부터 `windowMs` 전까지 사이의 올바른 시각인가. 없거나 잘못되거나 (시계 차이를 넘는) 미래인 값은 아니다. */
const isRecent = (value: unknown, windowMs: number): boolean => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return false;
  const elapsed = Date.now() - at;
  return elapsed >= -CLOCK_SKEW_MS && elapsed <= windowMs;
};

/** `statusCode` 가 끝난 상태(COMPLETED·CLOSED)만 쉼표로 나열했는가. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'CLOSED']);
const isFinishedStatusList = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const codes = value.split(',').map((code) => code.trim());
  return codes.length > 0 && codes.every((code) => FINISHED_STATUSES.has(code));
};

type TerminalType = 'POP' | 'MOBILE' | 'TRACKING_SYSTEM';

/** Explicit terminal GETs; each additional FR-005 group is reviewed for resource scope. */
export const TERMINAL_READ_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /mdm/workers': ['POP', 'MOBILE'],
  // MOBILE also reads its own row so registration can reject a non-MOBILE token before confirming (P-11).
  'GET /mdm/terminals/{terminalId}': ['POP', 'MOBILE'],
  'GET /production/work-orders': ['POP', 'MOBILE', 'TRACKING_SYSTEM'],
  'GET /production/work-sessions': ['POP'],
  'GET /mdm/terminals/{terminalId}/processes': ['POP'],
  'GET /trace/lots': ['POP', 'MOBILE'],
  'GET /logistics/shopfloor-receipts': ['POP'],
  'GET /production/work-orders/{workOrderId}': ['POP'],
  'GET /mdm/uoms': ['POP', 'MOBILE'],
  'GET /logistics/purchase-orders': ['MOBILE'],
  'GET /mdm/items': ['POP', 'MOBILE'],
  'GET /logistics/putaway-tasks': ['MOBILE'],
  'GET /logistics/picking-orders': ['MOBILE'],
  // ⭐ POP 도 읽는다 — P-06-01(창고 적재 위치 라벨 발행)이 창고를 고르고 그 위치를 뽑는다(장부
  //    P-28). 범위 판정은 채널을 가리지 않는다: 창고 목록은 컨트롤러가 단말 공장으로 좁히고,
  //    위치 목록은 아래 case 가 `warehouseId` 를 단말 공장 창고로 묶는다.
  'GET /mdm/warehouses': ['POP', 'MOBILE'],
  'GET /logistics/inbound-receipts': ['MOBILE'],
  'GET /mdm/equipments/{equipmentId}/inspection-items': ['POP', 'MOBILE'],
  'GET /mdm/locations': ['POP', 'MOBILE'],
  // TRACKING_SYSTEM 은 마감 사유(`WORK_ORDER_COMPLETION_VARIANCE_REASON`)를 읽는다(flowtrack 연동 제안 §3-5).
  'GET /mdm/code-values': ['POP', 'MOBILE', 'TRACKING_SYSTEM'],
  'GET /mdm/items/{itemId}': ['POP', 'MOBILE'],
  'GET /mdm/molds': ['POP'],
  'GET /mdm/molds/{moldId}': ['POP'],
  'GET /mdm/partners': ['POP', 'MOBILE'],
  // POP 은 같은 공장의 가동 설비 목록만 — 옆 설비의 W/O 를 찾아 대신 시작하는 현장 흐름(장부 P-123).
  'GET /mdm/equipments': ['POP', 'MOBILE'],
  'GET /mdm/locations/{locationId}': ['MOBILE'],
  'GET /maintenance/breakdowns': ['POP', 'MOBILE'],
  'GET /maintenance/downtimes': ['POP'],
  'GET /maintenance/downtimes/summary': ['POP'],
  'GET /maintenance/inspections': ['POP', 'MOBILE'],
  'GET /trace/lots/{lotId}': ['POP', 'MOBILE'],
  'GET /trace/lots/{lotId}/holds': ['MOBILE'],
  'GET /trace/serial-numbers': ['POP'],
  'GET /production/material-consumptions': ['POP'],
};

export async function assertTerminalReadScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const query = request.query as Record<string, unknown>;
  const plantId = terminal.plantId;

  /**
   * POP 의 W/O 단위 조회 — 그 W/O 공정의 이 단말 매핑에서 작업 시작·자재 투입·실적 입력 중 하나라도 켜져 있으면 읽는다.
   * 세 화면(작업 시작·투입·실적)이 모두 이 조회로 W/O 공정을 찾으므로, 화면에 들어갈 수 있는 단말은 읽어야 한다(장부 P-113).
   * 저장은 그 일의 플래그 하나만 본다(`terminal-production-scope.ts`).
   */
  const ownWorkOrder = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: plantId },
        ...(terminal.terminalTypeCode === 'POP'
          ? { released_at: { not: null }, completed_at: null, closed_at: null,
              NOT: { status_code: 'CANCELLED' },
              routing_operation: { process: { terminal_process: { some: {
                terminal_id: terminal.terminalId,
                OR: [{ can_start_work: true }, { can_input_material: true }, { can_input_result: true }],
              } } } } } : {}) },
      select: { work_order_id: true },
    });
    if (!row) throw denied();
  };
  /**
   * POP 은 자기 설비를 읽는다. `precheck` 는 작업 전 점검 게이트가 쓰는 설비 읽기다 — 작업 시작과 같은 범위라
   * 설비 있는 POP 도 단말 공장의 가동 설비(옆 설비로 시작 · 장부 P-123)를, 설비 없는 POP 은 W/O 가 없는 이 읽기에서
   * 단말 공장 안의 설비를 읽는다.
   */
  const ownEquipment = async (value: unknown, precheck = false): Promise<void> => {
    const id = positiveId(value);
    if (id === null) throw denied();
    const own = terminal.terminalTypeCode !== 'POP' || id === terminal.equipmentId;
    if (!own && !precheck) throw denied();
    const neighbor = !own && terminal.equipmentId !== null;
    const row = await prisma.equipment.findFirst({
      where: { equipment_id: id, plant_id: plantId, ...(neighbor ? NEIGHBOR_EQUIPMENT : {}) },
      select: { equipment_id: true },
    });
    if (!row) throw denied();
  };
  const plantEquipment = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.equipment.findFirst({
      where: { equipment_id: id, plant_id: plantId }, select: { equipment_id: true },
    });
    if (!row) throw denied();
  };
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: plantId }, select: { lot_id: true },
    });
    if (!row) throw denied();
  };
  switch (key) {
    case 'GET /mdm/workers':
      if (terminal.terminalTypeCode === 'POP' && !nonempty(query.workerNo)
        && positiveId(query.plantId) !== plantId) throw denied();
      requirePlantQuery(request, plantId);
      break;
    case 'GET /mdm/terminals/{terminalId}':
    case 'GET /mdm/terminals/{terminalId}/processes':
      if (positiveId(request.params.terminalId) !== terminal.terminalId) throw denied();
      break;
    case 'GET /production/work-orders':
      if (terminal.terminalTypeCode === 'POP') {
        // 설비 없는 POP 도 목록을 본다(설비가 정해지지 않은 W/O 를 시작한다).
        // 재작업 실적(P-04-03)은 배포 전(PLANNED) 재작업 W/O 도 «보이기만» 한다 — 지시가 났는지 현장이 알게(장부 P-113).
        //   고르기·저장은 배포된 것만이다(실적 저장이 PLANNED 를 받지 않는다).
        const plannedRework = query.workOrderTypeCode === 'REWORK' && query.statusCode === 'PLANNED';
        // POP 홈 「오늘 작업 현황」의 완료 수(omf-all-around#291) — 끝난 W/O(완료·마감)는 «최근 갱신분»만 본다.
        //   현장의 [작업지시 마감]은 W/O 를 CLOSED 로 바로 보내므로 마감도 «끝난 것»으로 센다.
        //   지난 이력 전체를 단말이 훑지 않도록 `updatedSince` 를 48시간 안으로 묶는다.
        const recentFinished = isFinishedStatusList(query.statusCode) && isRecent(query.updatedSince, RECENT_FINISHED_MS);
        if (query.open !== 'true' && !plannedRework && !recentFinished) throw denied();
        // 설비를 걸면 단말 공장의 설비여야 한다 — 옆 설비의 W/O 도 찾는다(장부 P-123). 없는 설비와 남의 공장 설비는 같은 401 이다.
        if (query.plannedEquipmentId !== undefined) await plantEquipment(query.plannedEquipmentId);
        // 목록 서비스가 이 단말의 공정 매핑으로 좁힌다 — 재작업은 실적 입력, 그 밖은 작업 시작 공정이다.
      } else if (terminal.terminalTypeCode !== 'TRACKING_SYSTEM') {
        await ownWorkOrder(query.successorOfWorkOrderId);
      }
      // TRACKING_SYSTEM 은 공장 W/O 전체를 읽는다 — 공장 범위는 목록 서비스(`workOrderListWhere`)가 모든 단말에 건다.
      break;
    case 'GET /production/work-sessions':
    case 'GET /logistics/shopfloor-receipts':
    case 'GET /production/material-consumptions':
      await ownWorkOrder(query.workOrderId);
      break;
    case 'GET /production/work-orders/{workOrderId}':
      await ownWorkOrder(request.params.workOrderId);
      break;
    case 'GET /trace/lots':
      if (!nonempty(query.lotNo) && !nonempty(query.q) && positiveId(query.itemId) === null
        && positiveId(query.workOrderId) === null) throw denied();
      if (query.workOrderId !== undefined) await ownWorkOrder(query.workOrderId);
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/purchase-orders':
      if (positiveId(query.itemId) === null) throw denied();
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/inbound-receipts':
      requirePlantQuery(request, plantId);
      break;
    case 'GET /logistics/putaway-tasks':
    case 'GET /logistics/picking-orders': {
      const workerId = positiveId(query.assignedWorkerId);
      const worker = workerId === null ? null : await prisma.worker.findFirst({
        where: { worker_id: workerId, plant_id: plantId, is_active: true },
        select: { worker_id: true },
      });
      if (!worker) throw denied();
      break;
    }
    case 'GET /mdm/equipments/{equipmentId}/inspection-items': {
      await ownEquipment(request.params.equipmentId, true);
      break;
    }
    case 'GET /mdm/locations': {
      const warehouseId = positiveId(query.warehouseId);
      const warehouse = warehouseId === null ? null : await prisma.warehouse.findFirst({
        where: { warehouse_id: warehouseId, plant_id: plantId },
        select: { warehouse_id: true },
      });
      if (!warehouse) throw denied();
      break;
    }
    case 'GET /mdm/locations/{locationId}': {
      const locationId = positiveId(request.params.locationId);
      const location = locationId === null ? null : await prisma.location.findFirst({
        where: { location_id: locationId, warehouse: { plant_id: plantId } },
        select: { location_id: true },
      });
      if (!location) throw denied();
      break;
    }
    case 'GET /mdm/molds':
      requirePlantQuery(request, plantId);
      break;
    case 'GET /mdm/equipments':
      requirePlantQuery(request, plantId);
      if (terminal.terminalTypeCode === 'POP') forceQuery(request, { statusCode: IN_SERVICE, includeInactive: undefined });
      break;
    case 'GET /mdm/molds/{moldId}': {
      const moldId = positiveId(request.params.moldId);
      const mold = moldId === null ? null : await prisma.mold.findFirst({
        where: { mold_id: moldId, plant_id: plantId },
        select: { mold_id: true },
      });
      if (!mold) throw denied();
      break;
    }
    case 'GET /mdm/items':
    case 'GET /mdm/items/{itemId}':
    case 'GET /mdm/partners':
    case 'GET /mdm/code-values':
    case 'GET /mdm/uoms':
    case 'GET /mdm/warehouses':
      break;
    case 'GET /maintenance/breakdowns':
    case 'GET /maintenance/inspections':
      await ownEquipment(query.equipmentId, true);
      break;
    case 'GET /maintenance/downtimes':
    case 'GET /maintenance/downtimes/summary':
      await ownEquipment(query.equipmentId);
      break;
    case 'GET /trace/lots/{lotId}':
    case 'GET /trace/lots/{lotId}/holds':
      await ownLot(request.params.lotId);
      break;
    case 'GET /trace/serial-numbers':
      await ownLot(query.lotId);
      break;
    default:
      throw denied();
  }
}

function requirePlantQuery(request: Request, plantId: bigint): void {
  const query = request.query as Record<string, unknown>;
  if (query.plantId !== undefined && positiveId(query.plantId) !== plantId) throw denied();
  forceQuery(request, { plantId: Number(plantId) });
}

/** 질의 칸을 덮어쓴다 — `undefined` 는 그 칸을 지운다. */
function forceQuery(request: Request, values: Record<string, unknown>): void {
  const query = { ...(request.query as Record<string, unknown>), ...values };
  for (const key of Object.keys(values)) if (values[key] === undefined) delete query[key];
  Object.defineProperty(request, 'query', { value: query, writable: true, configurable: true });
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
