import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalContext } from './terminal-context';

type TerminalType = 'POP' | 'MOBILE';

const OQC = 'OQC';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

/** Exact quality/repair GETs in the POP and MOBILE client API inventory. */
export const TERMINAL_QUALITY_READ_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  'GET /quality/inspection-requests': ['POP'],
  'GET /quality/inspection-requests/{inspectionRequestId}': ['POP'],
  // PQC 패널이 작성중 회차를 되살린다(omf-all-around#107 · 장부 P-49) — 볼 수 있는 의뢰의 회차·측정치만.
  'GET /quality/inspection-results': ['POP'],
  'GET /quality/inspection-results/{inspectionResultId}/measurements': ['POP'],
  // 시리얼 OQC(P-04-06 · omf-all-around#68 · 장부 P-101) — 단말 공장의 시리얼·의뢰만.
  'GET /quality/oqc-serials/{serialNo}': ['POP'],
  'GET /quality/inspection-requests/{inspectionRequestId}/oqc-serials': ['POP'],
  'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}': ['POP'],
  'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items': ['POP'],
  'GET /quality/inspection-plans/{inspectionPlanId}': ['POP'],
  'GET /quality/nonconformances/{nonconformanceId}': ['POP'],
  'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions': ['POP'],
  // POP 은 P-02-14 자재 불량 등록이 고른다(장부 P-52).
  'GET /quality/defect-codes': ['POP', 'MOBILE'],
  'GET /quality/defect-records': ['MOBILE'],
  'GET /production/repair-executions': ['MOBILE'],
};

export interface TerminalQualityReadScope {
  readonly plantId: bigint;
  readonly terminalId: bigint;
  readonly terminalTypeCode: TerminalType;
}

const ATTACHED = Symbol('terminalQualityReadScope');

export function currentTerminalQualityReadScope(request: Request): TerminalQualityReadScope | undefined {
  return (request as Request & { [ATTACHED]?: TerminalQualityReadScope })[ATTACHED];
}

/** POP inspection/NCR rows belong to a W/O routed to a process allowed on this terminal. */
export function terminalQualityWorkOrderWhere(scope: TerminalQualityReadScope): Prisma.work_orderWhereInput {
  return {
    production_line: { plant_id: scope.plantId },
    routing_operation: { process: { terminal_process: {
      some: { terminal_id: scope.terminalId, can_start_work: true },
    } } },
  };
}

/**
 * ⭐ POP OQC 출하검사 판정(P-04-06 · 장부 P-80) — OQC 의뢰에는 W/O 가 없어 위 공정 축으로 못 가른다.
 * 단말과 같은 공장이면 연다. 출하지시 대상은 다형 참조(`target_id`)라 관계로 못 걸어 지시 id 를
 * 먼저 푼다. ⛔ 출하 공장이 비어 있는 지시의 의뢰는 담지 않는다 — 「모른다」를 허용으로 읽지 않는다.
 */
async function terminalOqcRequestWhere(
  prisma: PrismaService, plantId: bigint,
): Promise<Prisma.inspection_requestWhereInput> {
  const shipments = await prisma.shipment_request.findMany({
    where: { fulfillment_plant_id: plantId }, select: { shipment_request_id: true },
  });
  return {
    inspection_type_code: OQC,
    OR: [
      { lot: { plant_id: plantId } },
      { target_type_code: SHIPMENT_REQUEST, target_id: { in: shipments.map((row) => row.shipment_request_id) } },
    ],
  };
}

/** 단말이 볼 수 있는 검사 의뢰 — 공정 매핑 W/O 의 의뢰(PQC) 또는 같은 공장의 OQC 의뢰. */
export async function terminalInspectionRequestWhere(
  prisma: PrismaService, scope: TerminalQualityReadScope,
): Promise<Prisma.inspection_requestWhereInput> {
  return { OR: [
    { work_order: terminalQualityWorkOrderWhere(scope) },
    await terminalOqcRequestWhere(prisma, scope.plantId),
  ] };
}

export async function assertTerminalQualityReadScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  const types = TERMINAL_QUALITY_READ_OPERATIONS[key];
  if (!types?.includes(terminal.terminalTypeCode as TerminalType)) throw denied();
  const scope: TerminalQualityReadScope = Object.freeze({
    plantId: terminal.plantId, terminalId: terminal.terminalId,
    terminalTypeCode: terminal.terminalTypeCode as TerminalType,
  });
  const query = request.query as Record<string, unknown>;
  const mappedWorkOrder = terminalQualityWorkOrderWhere(scope);
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: scope.plantId }, select: { lot_id: true },
    })) throw denied();
  };
  const ownWorkOrder = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.work_order.findFirst({
      where: { work_order_id: id, ...mappedWorkOrder }, select: { work_order_id: true },
    })) throw denied();
  };
  const ownInspectionRequest = async (where: Prisma.inspection_requestWhereInput): Promise<void> => {
    if (!await prisma.inspection_request.findFirst({
      where: { ...where, work_order: mappedWorkOrder }, select: { inspection_request_id: true },
    })) throw denied();
  };
  const ownPopInspectionRequest = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.inspection_request.findFirst({
      where: { AND: [{ inspection_request_id: id }, await terminalInspectionRequestWhere(prisma, scope)] },
      select: { inspection_request_id: true },
    })) throw denied();
  };
  const ownNonconformance = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    if (id === null || !await prisma.nonconformance.findFirst({
      where: { nonconformance_id: id,
        work_order_nonconformance_work_order_idTowork_order: mappedWorkOrder },
      select: { nonconformance_id: true },
    })) throw denied();
  };

  switch (key) {
    case 'GET /quality/inspection-requests':
      // OQC 목록은 W/O 없이 온다 — 공장 범위는 서비스가 `terminalInspectionRequestWhere` 로 좁힌다.
      if (query.workOrderId === undefined && query.inspectionTypeCode === OQC) break;
      await ownWorkOrder(query.workOrderId);
      break;
    case 'GET /quality/inspection-requests/{inspectionRequestId}':
      await ownPopInspectionRequest(request.params.inspectionRequestId);
      break;
    case 'GET /quality/inspection-requests/{inspectionRequestId}/oqc-serials':
      await ownPopInspectionRequest(request.params.inspectionRequestId);
      break;
    case 'GET /quality/oqc-serials/{serialNo}': {
      // 없는 시리얼은 서비스가 404 로 답한다. 있으면 그 LOT 이 단말 공장의 것이어야 한다 — 의뢰는 서비스가 좁힌다.
      const serial = await prisma.serial_number.findUnique({
        where: { serial_no: String(request.params.serialNo) }, select: { lot: { select: { plant_id: true } } },
      });
      if (serial !== null && serial.lot.plant_id !== scope.plantId) throw denied();
      break;
    }
    case 'GET /quality/inspection-results':
      // 회차 이력 — 볼 수 있는 의뢰 하나로만 연다.
      await ownPopInspectionRequest(query.inspectionRequestId);
      break;
    case 'GET /quality/inspection-results/{inspectionResultId}/measurements': {
      const id = positiveId(request.params.inspectionResultId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_result: { some: { inspection_result_id: id } } });
      break;
    }
    case 'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}':
    case 'GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items': {
      const id = positiveId(request.params.inspectionPlanVersionId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_plan_version_id: id });
      break;
    }
    case 'GET /quality/inspection-plans/{inspectionPlanId}': {
      const id = positiveId(request.params.inspectionPlanId);
      if (id === null) throw denied();
      await ownInspectionRequest({ inspection_plan_version: { inspection_plan_id: id } });
      break;
    }
    case 'GET /quality/nonconformances/{nonconformanceId}':
    case 'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions':
      await ownNonconformance(request.params.nonconformanceId);
      break;
    case 'GET /quality/defect-records':
      await ownLot(query.lotId);
      break;
    case 'GET /production/repair-executions':
      if (query.open !== 'true') throw denied();
      if (query.lotId !== undefined) await ownLot(query.lotId);
      break;
    case 'GET /quality/defect-codes':
      // Shared defect-code master has no plant relation in the schema.
      break;
    default:
      throw denied();
  }
  Object.defineProperty(request, ATTACHED, { value: scope, configurable: true });
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
