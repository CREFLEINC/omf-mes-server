import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
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
export type WorkSessionEventRow = Prisma.work_session_eventGetPayload<object>;
export type WorkSessionWorkerRow = Prisma.work_session_workerGetPayload<object>;
export type WorkSessionView = ReturnType<typeof workSessionView>;
export type WorkSessionEventView = ReturnType<typeof workSessionEventView>;
export type WorkSessionWorkerView = ReturnType<typeof workSessionWorkerView>;

/** 계약 `WorkSession`(11칸 · required 6)으로 옮기는 자리. ⛔ 값 없는 칸은 키를 생략한다. */
export function workSessionView(row: WorkSessionRow) {
  return omitEmpty({
    workSessionId: Number(row.work_session_id),
    workOrderId: Number(row.work_order_id),
    sessionNo: row.session_no,
    shiftId: id(row.shift_id),
    equipmentId: id(row.equipment_id),
    moldId: id(row.mold_id),
    terminalId: Number(row.terminal_id),
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

/** 계약 `WorkSessionWorker`(4칸 · required 4)로 옮기는 자리. */
export function workSessionWorkerView(row: WorkSessionWorkerRow) {
  return omitEmpty({
    workSessionWorkerId: Number(row.work_session_worker_id),
    workerId: Number(row.worker_id),
    workerRoleCode: row.worker_role_code,
    joinedAt: row.joined_at.toISOString(),
    leftAt: row.left_at === null ? undefined : row.left_at.toISOString(),
  });
}

/** 이벤트 행이 속한 「그룹:코드」 키 — `reasonName` 조회의 맵 키와 같은 모양이어야 한다. */
export function reasonKey(row: Pick<WorkSessionEventRow, 'event_type_code' | 'reason_code'>): string | undefined {
  const group = REASON_GROUP_BY_EVENT_TYPE[row.event_type_code];
  if (group === undefined || row.reason_code === null) return undefined;
  return `${group}:${row.reason_code}`;
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
