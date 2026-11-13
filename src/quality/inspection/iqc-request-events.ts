import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { requestLotIds } from './inspection-request-lots';

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
  const [reasonNames, requested] = await Promise.all([
    reinspectionReasonNames(prisma, rows.map((row) => row.summary_after ?? row.summary_before)),
    requestedLine(prisma, request.inspection_request_id, rows.some((row) => row.event_type_code === 'SPLIT_IN')),
  ]);
  return [
    {
      occurredAt: request.requested_at.toISOString(), eventCode: 'REQUESTED', actorName: requested.actorName, detail: requested.detail,
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

/**
 * 「검사 의뢰 생김」 한 줄 — 어떻게 생겼나(입하 마감·날짜 자동 마감·분리·선별)와 자재 관리 LOT 수·수량(T142).
 * 입하 마감이 만든 요청은 그 마감 기록(`RECEIPT_CLOSED` · 요약 `iqcRequestId`)의 행위자·LOT 수를 쓴다 — 마감 뒤 분리로 LOT 이 줄어도
 * 생길 때의 수다. 옛 마감 기록(LOT 수 없음)·분리·선별로 생긴 요청은 지금 요청의 LOT 수와 대상 수량이다.
 */
async function requestedLine(
  prisma: PrismaService, inspectionRequestId: bigint, splitIn: boolean,
): Promise<{ actorName: string | null; detail: string | null }> {
  const request = await prisma.inspection_request.findUniqueOrThrow({
    where: { inspection_request_id: inspectionRequestId },
    select: {
      inbound_lot_id: true, lot_id: true, target_qty: true, split_from_inspection_request_id: true, uom: { select: { uom_code: true } },
    },
  });
  if (request.inbound_lot_id === null) return { actorName: null, detail: null };
  const closed = await prisma.inbound_lot_event.findFirst({
    where: { inbound_lot_id: request.inbound_lot_id, event_type_code: 'RECEIPT_CLOSED', summary: { path: ['iqcRequestId'], equals: String(inspectionRequestId) } },
    select: { summary: true, actor_user: { select: { user_name: true } }, actor_worker: { select: { worker_name: true } } },
  });
  const summary = objectOf(closed?.summary ?? null);
  const lotCount = typeof summary?.lotCount === 'number' ? summary.lotCount : (await requestLotIds(prisma, request)).length;
  const qty = typeof summary?.qty === 'string' ? summary.qty : request.target_qty.toString();
  const how = closed !== null ? (summary?.auto === true ? '날짜 자동 마감' : '입하 마감')
    : request.split_from_inspection_request_id !== null ? '선별로 생김' : splitIn ? '자재 관리 LOT 분리로 생김' : null;
  const counts = `자재 관리 LOT ${String(lotCount)}개 · ${qty} ${request.uom.uom_code}`;
  return {
    actorName: closed?.actor_worker?.worker_name ?? closed?.actor_user?.user_name ?? null,
    detail: how === null ? counts : `${how} — ${counts}`,
  };
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
  // 합격·불합격·보류 수량도 싣는다 — 수량만 고친 수정도 전·후 줄이 달라 보인다(T142).
  const split = [['합격', summary.acceptedQty], ['불합격', summary.rejectedQty], ['보류', summary.heldQty]]
    .flatMap(([name, qty]) => (typeof qty === 'number' && qty > 0 ? [`${String(name)} ${String(qty)}`] : []));
  const qtys = `검사 ${String(summary.inspectedQty)}${split.length === 0 ? '' : `(${split.join(' · ')})`}`;
  return `결과 ${String(summary.inspectionRound)} ${verb} — ${judgment} · ${qtys}${lots.length === 0 ? '' : ` · 매칭 ${lots.join(', ')}`}${reinspection}`;
}
