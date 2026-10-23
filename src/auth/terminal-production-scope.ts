import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import type { TerminalContext } from './terminal-context';

/** POP production actions supported by an installed terminal, never administrator actions. */
export const TERMINAL_PRODUCTION_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'GET /production/work-sessions/{workSessionId}/events': ['POP'],
  'GET /production/work-sessions/{workSessionId}/workers': ['POP'],
  'POST /production/work-sessions/{workSessionId}/workers': ['POP'],
  'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave': ['POP'],
  'POST /production/precheck-decisions': ['POP'],
  'POST /production/work-sessions': ['POP'],
  'POST /production/work-orders/{workOrderId}:hold': ['POP'],
  'POST /production/work-orders/{workOrderId}:resume': ['POP'],
  'POST /production/work-orders/{workOrderId}:close': ['POP'],
  'POST /production/work-sessions/{workSessionId}/events': ['POP'],
  'POST /production/production-results': ['POP'],
  'POST /trace/serial-numbers': ['POP'],
  'POST /production/material-consumptions': ['POP'],
  'POST /trace/lots/{lotId}:complete': ['POP'],
  'POST /production/work-sessions/{workSessionId}:end': ['POP'],
};

export async function assertTerminalProductionScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (terminal.terminalTypeCode !== 'POP' || !TERMINAL_PRODUCTION_OPERATIONS[key]) throw denied();
  const body = object(request.body);
  /**
   * 단말 범위 안의 W/O 면 그 계획 설비를 돌려준다. 그 W/O 공정의 이 단말 매핑에서 그 일의 기능 플래그를 본다 —
   * 화면 후보(`terminal-accessible-screens.ts`)와 같은 플래그라, 화면에 들어갈 수 있으면 저장도 된다(장부 P-113).
   * 매핑이 없으면 범위 밖, 매핑은 있는데 플래그만 꺼졌으면 켤 곳을 알려 준다.
   */
  const ownWorkOrder = async (value: unknown, flag: WorkOrderFlag): Promise<bigint | null> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: terminal.plantId },
        released_at: { not: null }, completed_at: null, closed_at: null,
        NOT: { status_code: 'CANCELLED' },
      },
      select: {
        planned_equipment_id: true,
        routing_operation: { select: { process: { select: { terminal_process: {
          where: { terminal_id: terminal.terminalId }, select: { [flag]: true },
        } } } } },
      },
    });
    if (!row) throw await outOfScope(id);
    const mapping = row.routing_operation.process.terminal_process[0] as Partial<Record<WorkOrderFlag, boolean>> | undefined;
    if (mapping === undefined) throw denied();
    if (mapping[flag] !== true) throw flagDenied(FLAG_NAME[flag]);
    return row.planned_equipment_id ?? null;
  };
  /**
   * 마감은 작업 시작과 다른 권한이다 — 그 W/O 공정 매핑의 「작업지시 마감」(`can_close_work_order`)으로 가른다(장부 P-108).
   * 권한만 빠진 경우는 조치를 알려 준다 — 「범위 밖」만으로는 관리자가 무엇을 켜야 할지 모른다.
   */
  const closableWorkOrder = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: terminal.plantId },
        released_at: { not: null }, closed_at: null, NOT: { status_code: 'CANCELLED' } },
      select: { routing_operation: { select: { process: { select: { terminal_process: {
        where: { terminal_id: terminal.terminalId }, select: { can_close_work_order: true },
      } } } } } },
    });
    if (!row) throw await outOfScope(id);
    const mapping = row.routing_operation.process.terminal_process[0];
    if (mapping === undefined) throw denied();
    if (!mapping.can_close_work_order) throw flagDenied('작업지시 마감');
  };
  /**
   * 이 단말이 그 W/O 에 걸 수 있는 설비 — 설비 단말은 자기 설비, 설비 없는 단말은 W/O 의 계획 설비다.
   * 둘 다 없으면 걸 설비가 없다(작업 전 점검 없이 시작한다).
   */
  const usableEquipment = (plannedEquipmentId: bigint | null): bigint | null => terminal.equipmentId ?? plannedEquipmentId;
  const assertEquipment = (usable: bigint | null, value: unknown): void => {
    if (usable === null) throw scopeDenied(NO_EQUIPMENT);
    if (positiveId(value) !== usable) throw scopeDenied(OTHER_EQUIPMENT);
  };
  /**
   * 범위 밖인 까닭이 W/O 상태(배포 전·완료·마감·취소)뿐이면 그 까닭과 할 일을 알린다 — 단말 공장의 W/O 이고 이 단말이
   * 그 공정에 매핑돼 있을 때만이다(남의 공장·매핑 없는 W/O 의 상태를 알려 주지 않는다). 그 밖은 「범위 밖」 그대로다.
   */
  const outOfScope = async (id: bigint | null): Promise<ContractException> => {
    const row = id === null ? null : await prisma.work_order.findFirst({
      where: { work_order_id: id, production_line: { plant_id: terminal.plantId },
        routing_operation: { process: { terminal_process: { some: { terminal_id: terminal.terminalId } } } } },
      select: { status_code: true, released_at: true, completed_at: true, closed_at: true },
    });
    const reason = row === null ? undefined
      : row.status_code === 'CANCELLED' ? '이 W/O 는 취소됐습니다 — W/O 목록을 새로 고쳐 확인하세요.'
      : row.closed_at !== null ? '이 W/O 는 마감됐습니다 — W/O 목록을 새로 고쳐 확인하세요.'
      : row.completed_at !== null ? '이 W/O 는 완료됐습니다 — W/O 목록을 새로 고쳐 확인하세요.'
      : row.released_at === null ? '이 W/O 는 배포 전입니다 — 관리웹에서 배포한 뒤 작업하세요.'
      : undefined;
    return reason === undefined ? denied() : new ContractException(HttpStatus.UNAUTHORIZED, [
      { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: reason },
    ]);
  };
  /**
   * 세션 사건·참여자 «읽기»는 다른 단말이 연 세션도 읽는다 — 같은 W/O 를 고른 단말이 「누가 이미 작업 중인지」를 보여야 한다.
   * 기준은 W/O 단위 조회와 같다(그 W/O 공정에 작업 시작·자재 투입·실적 입력 중 하나라도 켠 매핑 · 장부 P-113). 쓰기는 자기 세션만이다.
   */
  const readableSession = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_session.findFirst({
      where: { work_session_id: id, work_order: { production_line: { plant_id: terminal.plantId },
        released_at: { not: null }, completed_at: null, closed_at: null, NOT: { status_code: 'CANCELLED' },
        routing_operation: { process: { terminal_process: { some: {
          terminal_id: terminal.terminalId,
          OR: [{ can_start_work: true }, { can_input_material: true }, { can_input_result: true }],
        } } } } } },
      select: { work_session_id: true },
    });
    if (!row) throw denied();
  };
  const ownSession = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.work_session.findFirst({
      where: { work_session_id: id, terminal_id: terminal.terminalId,
        work_order: { production_line: { plant_id: terminal.plantId } } },
      select: { work_session_id: true },
    });
    if (!row) throw denied();
  };
  /** 함께 일할 사람(시작 때의 부작업자·작업 중 참여)도 이 단말 공장의 재직 작업자여야 한다. */
  const plantWorkers = async (values: unknown[]): Promise<void> => {
    const ids = values.map(positiveId);
    if (ids.some((id) => id === null)) throw denied();
    const unique = [...new Set(ids as bigint[])];
    if (unique.length === 0) return;
    const found = await prisma.worker.count({
      where: { worker_id: { in: unique }, plant_id: terminal.plantId, is_active: true },
    });
    if (found !== unique.length) throw denied();
  };
  const ownLot = async (value: unknown): Promise<void> => {
    const id = positiveId(value);
    const row = id === null ? null : await prisma.lot.findFirst({
      where: { lot_id: id, plant_id: terminal.plantId }, select: { lot_id: true },
    });
    if (!row) throw denied();
  };

  if (key.startsWith('POST ')) await activeWorker(prisma, request, terminal.plantId);
  switch (key) {
    case 'GET /production/work-sessions/{workSessionId}/events':
    case 'GET /production/work-sessions/{workSessionId}/workers':
      await readableSession(request.params.workSessionId);
      break;
    case 'POST /production/work-sessions/{workSessionId}/events':
    case 'POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave':
    case 'POST /production/work-sessions/{workSessionId}:end':
      await ownSession(request.params.workSessionId);
      break;
    case 'POST /production/work-sessions/{workSessionId}/workers':
      await ownSession(request.params.workSessionId);
      if (given(body.workerId)) await plantWorkers([body.workerId]);
      break;
    case 'POST /production/precheck-decisions': {
      if (!given(body.workOrderId) || !given(body.equipmentId)) break;
      assertEquipment(usableEquipment(await ownWorkOrder(body.workOrderId, 'can_start_work')), body.equipmentId);
      break;
    }
    case 'POST /production/work-sessions': {
      if (!given(body.workOrderId)) break;
      const equipmentId = usableEquipment(await ownWorkOrder(body.workOrderId, 'can_start_work'));
      await plantWorkers(array(body.workerIds).filter(given));
      if (given(body.equipmentId)) assertEquipment(equipmentId, body.equipmentId);
      if (given(body.moldId)) {
        const moldId = positiveId(body.moldId);
        if (moldId === null || !await prisma.mold.findFirst({
          where: { mold_id: moldId, plant_id: terminal.plantId }, select: { mold_id: true },
        })) throw scopeDenied(FOREIGN_MOLD);
      }
      break;
    }
    case 'POST /production/work-orders/{workOrderId}:hold':
    case 'POST /production/work-orders/{workOrderId}:resume':
      await ownWorkOrder(request.params.workOrderId, 'can_start_work');
      break;
    case 'POST /production/work-orders/{workOrderId}:close':
      await closableWorkOrder(request.params.workOrderId);
      break;
    case 'POST /production/production-results':
      if (!given(body.workOrderId)) break;
      await ownWorkOrder(body.workOrderId, 'can_input_result');
      for (const allocation of array(body.lotAllocations)) {
        const lotId = object(allocation).lotId;
        if (given(lotId)) await ownLot(lotId);
      }
      break;
    case 'POST /trace/serial-numbers':
      if (given(body.lotId)) await ownLot(body.lotId);
      break;
    case 'POST /production/material-consumptions':
      if (!given(body.workOrderId) || !given(body.lotId)) break;
      await ownWorkOrder(body.workOrderId, 'can_input_material');
      await ownLot(body.lotId);
      if (given(body.workSessionId)) await ownSession(body.workSessionId);
      break;
    case 'POST /trace/lots/{lotId}:complete':
      await ownLot(request.params.lotId);
      break;
    default:
      throw denied();
  }
}

async function activeWorker(prisma: PrismaService, request: Request, plantId: bigint): Promise<void> {
  const workerNo = request.headers['x-worker-no'];
  if (typeof workerNo !== 'string' || !workerNo.trim() || !await prisma.worker.findFirst({
    where: { worker_no: workerNo.trim(), plant_id: plantId, is_active: true },
    select: { worker_id: true },
  })) throw denied();
}

function positiveId(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = BigInt(text);
  return id > 0n && id < 9223372036854775808n ? id : null;
}
/**
 * 본문 id 칸을 범위로 가를 수 있는지 — 양의 정수일 때만 범위를 본다. 빠졌거나 null·문자열·소수·0·음수처럼 계약상 틀린 값은
 * 범위로 가르지 않고 계약 검증(뒤 가드)·업무 검증에 넘긴다.
 * 범위 판정이 인증 가드 안이라 계약 검증보다 먼저 돈다 — 여기서 틀린 값을 범위 밖으로 보면 400 이어야 할 본문이 401 이 된다.
 * ⛔ 필수 칸을 가를 수 없으면 그 요청의 범위 판정을 건너뛴다 — 뒤 가드가 null·문자열·소수를 400 으로 막고, 0·음수는 그런
 *    행이 없어 업무 검증이 막는다는 것이 전제다. 그 칸을 nullable 로 바꾸면 여기서 범위를 다시 봐야 한다.
 */
function given(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
/** W/O 단위 일의 기능 플래그 — 마감(`can_close_work_order`)은 미완료 조건이 달라 `closableWorkOrder` 가 따로 본다. */
type WorkOrderFlag = 'can_start_work' | 'can_input_material' | 'can_input_result';
/** 관리웹 시스템 관리 › 단말기-공정 매핑 화면의 기능 이름 — 문구가 켤 칸을 짚는다. */
const FLAG_NAME: Record<WorkOrderFlag, string> = {
  can_start_work: '작업 시작',
  can_input_material: '자재 투입',
  can_input_result: '실적 입력',
};

function flagDenied(name: string): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [{
    scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
    message: `이 단말에는 이 W/O 공정의 ${name} 권한이 없습니다. 관리웹 시스템 관리 › 단말기-공정 매핑에서 해당 공정의 「${name}」을 켜세요.`,
  }]);
}

const FOREIGN_MOLD = '고른 금형이 이 단말 공장의 금형이 아닙니다. 관리웹 기준정보 관리 › 툴·금형 › 툴/금형/지그 마스터에서 금형의 공장을 확인하거나 다른 금형을 고르세요.';
const NO_EQUIPMENT = '이 단말에 연결된 설비도, 이 W/O 의 계획 설비도 없어 설비를 실을 수 없습니다. 관리웹 시스템 관리 › 단말기-공정 매핑에서 이 단말의 설비를 연결하세요.';
const OTHER_EQUIPMENT = '고른 설비가 이 단말의 설비(단말에 설비가 없으면 W/O 의 계획 설비)가 아닙니다. 관리웹 시스템 관리 › 단말기-공정 매핑에서 이 단말의 설비를 확인하거나 그 설비의 단말에서 작업하세요.';

function scopeDenied(message: string): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message }]);
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
