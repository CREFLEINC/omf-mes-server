import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { participatedMinutes } from './crew';
import { REASON_GROUP_BY_EVENT_TYPE } from './work-session.constants';

/** 이벤트 목록의 계약 정렬 — `occurred_at` 오름차순, 동률은 PK 오름차순(§8). */
export const WORK_SESSION_EVENT_ORDER_BY: Prisma.work_session_eventOrderByWithRelationInput[] = [
  { occurred_at: 'asc' },
  { work_session_event_id: 'asc' },
];

/** 작업자 목록의 계약 정렬 — 참여 순(PK 오름차순, §8). */
export const WORK_SESSION_WORKER_ORDER_BY: Prisma.work_session_workerOrderByWithRelationInput[] = [
  { work_session_worker_id: 'asc' },
];

export type WorkSessionRow = Prisma.work_sessionGetPayload<object>;
/**
 * 어느 단말·누구의 세션인지 — 열린 세션을 「어디서 끝낼지」 안내하는 칸이다(장부 P-104). 작업자는 주작업자이고,
 * 역할이 없던 옛 세션은 비운다. 조회만 읽는다 — 시작·종료 응답에는 키가 없다.
 */
export const WORK_SESSION_DISPLAY_INCLUDE = {
  terminal: { select: { terminal_code: true } },
  work_session_worker: {
    where: { worker_role_code: 'MAIN' },
    take: 1,
    select: { worker: { select: { worker_id: true, worker_no: true, worker_name: true } } },
  },
} as const;
type WorkSessionDisplay = Prisma.work_sessionGetPayload<{ include: typeof WORK_SESSION_DISPLAY_INCLUDE }>;
export type WorkSessionEventRow = Prisma.work_session_eventGetPayload<object>;
/** 참여자 표시에 필요한 사람 칸 — 사번·이름은 화면이 사람을 알아보는 값이다. */
export const WORK_SESSION_WORKER_INCLUDE = { worker: { select: { worker_no: true, worker_name: true } } } as const;
export type WorkSessionWorkerRow = Prisma.work_session_workerGetPayload<{ include: typeof WORK_SESSION_WORKER_INCLUDE }>;
export type WorkSessionView = ReturnType<typeof workSessionView>;
export type WorkSessionEventView = ReturnType<typeof workSessionEventView>;
export type WorkSessionWorkerView = ReturnType<typeof workSessionWorkerView>;

/** 계약 `WorkSession` 으로 옮기는 자리. ⛔ 값 없는 칸은 키를 생략한다. */
export function workSessionView(row: WorkSessionRow & Partial<Pick<WorkSessionDisplay, 'terminal' | 'work_session_worker'>>) {
  const worker = row.work_session_worker?.[0]?.worker;
  return omitEmpty({
    workSessionId: Number(row.work_session_id),
    workOrderId: Number(row.work_order_id),
    sessionNo: row.session_no,
    shiftId: id(row.shift_id),
    equipmentId: id(row.equipment_id),
    moldId: id(row.mold_id),
    terminalId: Number(row.terminal_id),
    terminalCode: row.terminal?.terminal_code,
    workerId: worker === undefined ? undefined : Number(worker.worker_id),
    workerNo: worker?.worker_no,
    workerName: worker?.worker_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at === null ? undefined : row.ended_at.toISOString(),
    statusCode: row.status_code,
    // `stopReasonCode` 는 계약이 «비우기로 정했다»(A-21·A-25) — 물리에 값이 있어도 안 낸다.
    remarks: row.remarks ?? undefined,
    versionNo: row.version_no,
  });
}

/**
 * 계약 `WorkSessionEvent`(7칸 · required 3)로 옮기는 자리. `reasonName` 은 파생 칸이다 —
 * `mdm.code_value.code_name` 을 조회 서비스가 한 번에 모아 건네준다(N+1 방지, §8 ⭐).
 * 표시명이 없으면 키를 생략한다(널 금지 · `plan.md` §5 규칙 7).
 */
export function workSessionEventView(row: WorkSessionEventRow, reasonName: string | undefined) {
  return omitEmpty({
    workSessionEventId: Number(row.work_session_event_id),
    eventTypeCode: row.event_type_code,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.created_at.toISOString(),
    reasonCode: row.reason_code ?? undefined,
    reasonName,
    performedBy: id(row.performed_by),
    terminalId: id(row.terminal_id),
  });
}

/**
 * 계약 `WorkSessionWorker` 로 옮기는 자리. `participatedMinutes` 는 저장하지 않고 이 참여 구간에서 계산한다 —
 * 떠나지 않았으면 세션 종료까지, 세션도 열려 있으면 `now` 까지.
 */
export function workSessionWorkerView(row: WorkSessionWorkerRow, sessionEndedAt: Date | null, now: Date) {
  return omitEmpty({
    workSessionWorkerId: Number(row.work_session_worker_id),
    workerId: Number(row.worker_id),
    workerNo: row.worker.worker_no,
    workerName: row.worker.worker_name,
    workerRoleCode: row.worker_role_code,
    joinedAt: row.joined_at.toISOString(),
    leftAt: row.left_at === null ? undefined : row.left_at.toISOString(),
    participatedMinutes: participatedMinutes(row.joined_at, row.left_at, sessionEndedAt, now),
  });
}

/** 이벤트 행이 속한 「그룹:코드」 키 — `reasonName` 조회의 맵 키와 같은 모양이어야 한다. */
export function reasonKey(row: Pick<WorkSessionEventRow, 'event_type_code' | 'reason_code'>): string | undefined {
  const group = REASON_GROUP_BY_EVENT_TYPE[row.event_type_code];
  if (group === undefined || row.reason_code === null) return undefined;
  return `${group}:${row.reason_code}`;
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
