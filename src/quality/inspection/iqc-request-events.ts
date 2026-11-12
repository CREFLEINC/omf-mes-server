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
  return [
    {
      occurredAt: request.requested_at.toISOString(), eventCode: 'REQUESTED', actorName: null, detail: null,
      inspectionResultId: null, summaryBefore: null, summaryAfter: null, reason: null,
    },
    ...rows.map((row) => ({
      occurredAt: row.occurred_at.toISOString(),
      eventCode: row.event_type_code,
      actorName: row.actor_worker?.worker_name ?? row.actor_user?.user_name ?? null,
      detail: resultDetail(row.event_type_code, row.summary_after ?? row.summary_before) ?? row.reason,
      inspectionResultId: row.inspection_result_id === null ? null : Number(row.inspection_result_id),
      summaryBefore: row.summary_before,
      summaryAfter: row.summary_after,
      reason: row.reason,
    })),
  ];
}

/** 「결과 1 기록 — 합격 · 검사 200 · 매칭 0001, 0002」 — 매칭은 LOT 번호 끝 4자리. 결과 이벤트가 아니면 `null`. */
function resultDetail(eventCode: string, summary: Prisma.JsonValue | null): string | null {
  const verb = RESULT_VERB[eventCode];
  if (verb === undefined || summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const judgment = typeof summary.overallJudgmentCode === 'string' ? (JUDGMENT_NAME[summary.overallJudgmentCode] ?? summary.overallJudgmentCode) : '판정 없음';
  const lots = Array.isArray(summary.matchedLotNos) ? summary.matchedLotNos.map((no) => String(no).slice(-4)) : [];
  return `결과 ${String(summary.inspectionRound)} ${verb} — ${judgment} · 검사 ${String(summary.inspectedQty)}${lots.length === 0 ? '' : ` · 매칭 ${lots.join(', ')}`}`;
}
