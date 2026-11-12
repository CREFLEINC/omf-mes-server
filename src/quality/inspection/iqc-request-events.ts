import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * 검사 이력의 변경 이력 한 줄(피처 005 R-11) — 칸 이름은 클라이언트 C3 이 정한 것(`requestEvents[]`). `eventCode` 는
 * `INSPECTION_REQUEST_EVENT_TYPE` 값 그대로이고(맨 앞 줄만 요청 생성 `REQUESTED`), `detail` 은 서버가 만든 한 줄이다.
 */
export interface InspectionRequestEventLine {
  occurredAt: string;
  eventCode: string;
  actorName: string | null;
  detail: string | null;
  inspectionResultId: number | null;
  summaryBefore: Prisma.JsonValue | null;
  summaryAfter: Prisma.JsonValue | null;
  reason: string | null;
}

const JUDGMENT_NAME: Record<string, string> = { ACCEPTED: '합격', REJECTED: '불합격', HELD: '보류' };
const RESULT_VERB: Record<string, string> = { RESULT_ADDED: '기록', RESULT_UPDATED: '수정', RESULT_DELETED: '삭제' };

export async function inspectionRequestEventLines(
  prisma: PrismaService,
  request: { inspection_request_id: bigint; requested_at: Date },
): Promise<InspectionRequestEventLine[]> {
  const rows = await prisma.inspection_request_event.findMany({
    where: { inspection_request_id: request.inspection_request_id },
    orderBy: [{ occurred_at: 'asc' }, { inspection_request_event_id: 'asc' }],
    select: {
      event_type_code: true, inspection_result_id: true, summary_before: true, summary_after: true, reason: true, occurred_at: true,
      actor_user: { select: { user_name: true } }, actor_worker: { select: { worker_name: true } },
    },
  });
  const reasonNames = await reinspectionReasonNames(prisma, rows.map((row) => row.summary_after ?? row.summary_before));
  return [
    {
      occurredAt: request.requested_at.toISOString(), eventCode: 'REQUESTED', actorName: null, detail: null,
      inspectionResultId: null, summaryBefore: null, summaryAfter: null, reason: null,
    },
    ...rows.map((row) => ({
      occurredAt: row.occurred_at.toISOString(),
      eventCode: row.event_type_code,
      actorName: row.actor_worker?.worker_name ?? row.actor_user?.user_name ?? null,
      detail: eventDetail(row.event_type_code, row.summary_before, row.summary_after, row.reason, reasonNames),
      inspectionResultId: row.inspection_result_id === null ? null : Number(row.inspection_result_id),
      summaryBefore: row.summary_before,
      summaryAfter: row.summary_after,
      reason: row.reason,
    })),
  ];
}

/** 결과 이벤트에 남은 재검 사유 코드의 이름(공통코드 `REINSPECTION_REASON` — 열린 그룹이라 없을 수 있다). */
async function reinspectionReasonNames(prisma: PrismaService, summaries: (Prisma.JsonValue | null)[]): Promise<Map<string, string>> {
  const codes = [...new Set(summaries.flatMap((summary) => {
    const code = objectOf(summary)?.reinspectionReasonCode;
    return typeof code === 'string' ? [code] : [];
  }))];
  if (codes.length === 0) return new Map();
  const rows = await prisma.code_value.findMany({
    where: { code: { in: codes }, code_group: { group_code: 'REINSPECTION_REASON' } }, select: { code: true, code_name: true },
  });
  return new Map(rows.map((row) => [row.code, row.code_name]));
}

function objectOf(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const LOT_STATE: Record<string, string> = { ACCEPTED: '정상', REJECTED: '불량', HELD: '보류' };

/** 이벤트마다 서버가 만든 한 줄(계약 `InspectionRequestEventLine.detail`). 만들 것이 없으면 사유. */
function eventDetail(
  eventCode: string, before: Prisma.JsonValue | null, after: Prisma.JsonValue | null, reason: string | null, reasonNames: Map<string, string>,
): string | null {
  if (eventCode === 'CONFIRMED') return confirmedDetail(objectOf(after));
  if (eventCode === 'CONFIRM_CANCELLED') {
    const previous = objectOf(before);
    const judgment = typeof previous?.overallJudgmentCode === 'string' ? (JUDGMENT_NAME[previous.overallJudgmentCode] ?? previous.overallJudgmentCode) : '판정 없음';
    const cancelled = Array.isArray(previous?.nonconformanceIds) ? previous.nonconformanceIds.length : 0;
    return `이전 확정: ${judgment}${cancelled > 0 ? ` · 부적합 ${String(cancelled)}건 취소` : ''}${reason === null ? '' : ` (사유: ${reason})`}`;
  }
  return resultDetail(eventCode, after ?? before, reasonNames) ?? reason;
}

/** 「합격 — 자재 관리 LOT 3개 정상」·「불합격 — 자재 관리 LOT 3개 불량 · 부적합 NC-…」. */
function confirmedDetail(summary: Prisma.JsonObject | null): string | null {
  const code = summary?.overallJudgmentCode;
  if (typeof code !== 'string') return null;
  const count = typeof summary?.lotCount === 'number' ? `자재 관리 LOT ${String(summary.lotCount)}개 ` : '자재 관리 LOT ';
  const nc = typeof summary?.nonconformanceNo === 'string' ? ` · 부적합 ${summary.nonconformanceNo}` : '';
  return `${JUDGMENT_NAME[code] ?? code} — ${count}${LOT_STATE[code] ?? ''}${nc}`;
}

/** 「결과 1 기록 — 합격 · 검사 200 · 매칭 0001, 0002」 — 매칭은 LOT 번호 끝 4자리. 결과 이벤트가 아니면 `null`. */
function resultDetail(eventCode: string, summary: Prisma.JsonValue | null, reasonNames: Map<string, string>): string | null {
  const verb = RESULT_VERB[eventCode];
  if (verb === undefined || summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const judgment = typeof summary.overallJudgmentCode === 'string' ? (JUDGMENT_NAME[summary.overallJudgmentCode] ?? summary.overallJudgmentCode) : '판정 없음';
  const lots = Array.isArray(summary.matchedLotNos) ? summary.matchedLotNos.map((no) => String(no).slice(-4)) : [];
  const reasonCode = typeof summary.reinspectionReasonCode === 'string' ? summary.reinspectionReasonCode : null;
  const reinspection = reasonCode === null ? '' : ` · 재검 사유 ${reasonNames.get(reasonCode) ?? reasonCode}`;
  return `결과 ${String(summary.inspectionRound)} ${verb} — ${judgment} · 검사 ${String(summary.inspectedQty)}${lots.length === 0 ? '' : ` · 매칭 ${lots.join(', ')}`}${reinspection}`;
}
