import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionRequestEventActor, recordInspectionRequestEvent } from './inspection-request-event';
import type { InspectionResultWriteContext } from './inspection-result-write-input';
import { IqcJudgedResult, reinspectionReasonRequired } from './iqc-overall-judgment';

/**
 * 입하 LOT IQC 요청(새 흐름 · 피처 005 R-10)의 결과 쓰기 규칙. 분기 기준은 `target_type_code='INBOUND_LOT'` 하나다 —
 * 이전된 옛 요청(대상 LOT · `inbound_lot_id` 만 채움)은 회차 사슬·결과 단위 확정 그대로라 여기 오지 않는다(FR-051).
 * 결과는 회차가 아니라 순번(`inspection_round` = 최대 + 1, 지운 번호 재사용 없음)·`DRAFT` 로만 서고,
 * 자재 관리 LOT 매칭(`quality.inspection_result_lot`)을 갖는다.
 */
export const INBOUND_LOT_TARGET = 'INBOUND_LOT';
const OPEN_REQUEST_STATUSES = ['REQUESTED', 'IN_PROGRESS'];
const INVALID_STATE = 'INVALID_STATE';
/** 계약 오류 코드(2026-11-12) — 결과마다 자재 관리 LOT 1개 이상, 불합격·보류를 덮는 결과에 재검 사유. */
const MATCHED_LOT_REQUIRED = 'MATCHED_LOT_REQUIRED';
const REINSPECTION_REASON_REQUIRED = 'REINSPECTION_REASON_REQUIRED';

type Db = PrismaService | Prisma.TransactionClient;

export interface InboundLotRequestFacts {
  inspection_request_id: bigint;
  status_code: string;
  inbound_lot_id: bigint | null;
}

/**
 * 본문의 회차·확정 칸 거절(400)과 요청 상태(409). 재검사 가드는 부르는 쪽이 먼저 건다. 재검 사유는 받는다 — 불합격·보류를 덮는
 * 결과에 필수다(`assertReinspectionReason`).
 */
export function assertInboundLotResultCreate(
  request: InboundLotRequestFacts,
  body: { previousResultId?: number; statusCode: string },
): void {
  if (body.previousResultId !== undefined) {
    throw one(field('previousResultId', ERROR_CODE.INVALID, '입하 LOT 검사는 회차를 쓰지 않습니다 — 재검사는 확정 취소 뒤 결과를 더합니다.'));
  }
  // POP 오프라인 큐의 「태어날 때 확정」을 막는다 — 입하 LOT 검사는 결과를 다 넣은 뒤 판정 확정이 한 번에 정한다(R10-3).
  if (body.statusCode !== 'DRAFT') {
    throw one(field('statusCode', ERROR_CODE.INVALID, '입하 LOT 검사 결과는 작성중(DRAFT)으로만 저장합니다 — 판정 확정은 검사 단위로 합니다.'));
  }
  assertRequestOpen(request.status_code);
}

export function assertRequestOpen(statusCode: string): void {
  if (OPEN_REQUEST_STATUSES.includes(statusCode)) return;
  throw new ConflictException('user', '판정 확정됐거나 끝난 검사입니다 — 결과를 더하거나 고치거나 지울 수 없습니다.', { code: INVALID_STATE });
}

/**
 * 재검사 가드에 넘길 LOT 상태 — 입하 LOT 의 자재 관리 LOT 중 불량이 하나라도 있으면 불량, 모두 검사 대기면 검사 대기,
 * 그 밖은 처음 만난 다른 상태. LOT 이 없으면 `undefined`(가드가 보지 않는다).
 */
export async function inboundLotReinspectStatus(db: Db, inboundLotId: bigint | null): Promise<string | undefined> {
  if (inboundLotId === null) return undefined;
  const lots = await db.lot.findMany({ where: { inbound_lot_id: inboundLotId }, select: { status_code: true }, orderBy: { lot_id: 'asc' } });
  const codes = lots.map((lot) => lot.status_code);
  if (codes.includes('DEFECTIVE')) return 'DEFECTIVE';
  return codes.find((code) => code !== 'INSPECTION_PENDING') ?? codes[0];
}

/** 다음 순번 — 남은 결과와 지운 결과(이력의 전 요약) 중 큰 것 + 1. 지운 번호를 다시 쓰지 않는다(R-10). */
export async function nextResultSequence(db: Db, inspectionRequestId: bigint): Promise<number> {
  const [kept, deleted] = await Promise.all([
    db.inspection_result.aggregate({ where: { inspection_request_id: inspectionRequestId }, _max: { inspection_round: true } }),
    db.$queryRaw<{ max: number | null }[]>`
      SELECT max((summary_before->>'inspectionRound')::int) AS max
        FROM quality.inspection_request_event
       WHERE inspection_request_id = ${inspectionRequestId} AND event_type_code = 'RESULT_DELETED'`,
  ]);
  return Math.max(kept._max.inspection_round ?? 0, deleted[0]?.max ?? 0) + 1;
}

export interface InboundLotWrite {
  inboundLotId: bigint;
  confirmCycle: number;
  /** `undefined` = 매칭을 손대지 않는다(PUT 에서 칸 생략) · 배열 = 통째로 갈아 끼운다. */
  matchedLotIds: bigint[] | undefined;
}

/**
 * 매칭 칸 검증 — 입하 LOT 요청이 아니면 `matchedLotIds` 를 받지 않는다(400). 입하 LOT 요청이면 1개 이상 필수(2026-11-12 —
 * 만들기는 칸 생략도 400, 고치기는 생략하면 지금 매칭 유지·빈 배열은 400), LOT 은 그 입하 LOT 소속만, 한 결과에 같은 LOT 두 번은
 * 400(결과끼리 중복은 허용 · US3-3). 입하 LOT 요청이 아니면 `null`.
 */
export async function prepareInboundLotWrite(
  db: Db,
  inspectionRequestId: bigint,
  matchedLotIds: readonly number[] | undefined,
  mode: 'create' | 'update' = 'create',
): Promise<InboundLotWrite | null> {
  const request = await db.inspection_request.findUnique({
    where: { inspection_request_id: inspectionRequestId },
    select: { target_type_code: true, inbound_lot_id: true, confirm_cycle: true },
  });
  if (request === null || request.target_type_code !== INBOUND_LOT_TARGET || request.inbound_lot_id === null) {
    if (matchedLotIds !== undefined) {
      throw one(field('matchedLotIds', ERROR_CODE.INVALID, '자재 관리 LOT 매칭은 입하 LOT 검사 결과에만 적습니다.'));
    }
    return null;
  }
  const base = { inboundLotId: request.inbound_lot_id, confirmCycle: request.confirm_cycle };
  if (matchedLotIds === undefined && mode === 'update') return { ...base, matchedLotIds: undefined };
  if (matchedLotIds === undefined || matchedLotIds.length === 0) {
    throw one(field('matchedLotIds', MATCHED_LOT_REQUIRED, '자재 관리 LOT를 1개 이상 고르세요.'));
  }
  const ids = matchedLotIds.map((id) => BigInt(id));
  if (new Set(ids).size !== ids.length) {
    throw one(field('matchedLotIds', ERROR_CODE.INVALID, '한 결과에 같은 자재 관리 LOT 을 두 번 매칭할 수 없습니다.'));
  }
  const owned = await db.lot.count({ where: { lot_id: { in: ids }, inbound_lot_id: request.inbound_lot_id } });
  if (owned !== ids.length) {
    throw one(field('matchedLotIds', ERROR_CODE.INVALID, '이 입하 LOT 의 자재 관리 LOT 만 매칭할 수 있습니다.'));
  }
  return { ...base, matchedLotIds: ids };
}

/** 결과 id 만 아는 `PUT` 이 요청을 찾는다. 없는 결과는 그 경로가 404 로 막는다. */
export async function prepareInboundLotWriteOfResult(
  db: Db,
  inspectionResultId: bigint,
  matchedLotIds: readonly number[] | undefined,
): Promise<InboundLotWrite | null> {
  const result = await db.inspection_result.findUnique({ where: { inspection_result_id: inspectionResultId }, select: { inspection_request_id: true } });
  return result === null ? null : prepareInboundLotWrite(db, result.inspection_request_id, matchedLotIds, 'update');
}

/** 요청들의 결과를 판정 계산 모양으로 — 순번·판정·매칭 LOT(R-10 「판정 규칙」). */
export async function judgedResultsOf(db: Db, inspectionRequestIds: readonly bigint[]): Promise<(IqcJudgedResult & { requestId: bigint })[]> {
  if (inspectionRequestIds.length === 0) return [];
  const rows = await db.inspection_result.findMany({
    where: { inspection_request_id: { in: [...inspectionRequestIds] } },
    orderBy: { inspection_round: 'asc' },
    select: { inspection_result_id: true, inspection_request_id: true, inspection_round: true, overall_judgment_code: true, inspection_result_lot: { select: { lot_id: true } } },
  });
  return rows.map((row) => ({
    requestId: row.inspection_request_id, resultId: row.inspection_result_id, seqNo: row.inspection_round,
    judgmentCode: row.overall_judgment_code, lotIds: row.inspection_result_lot.map((match) => match.lot_id),
  }));
}

/**
 * 재검 사유 필수(FR-023a · 2026-11-12) — 이 결과(만들기는 본문, 고치기는 본문이 없으면 저장값)가 매칭한 LOT 의 바로 앞 결과 판정을
 * 불합격 → 보류·합격, 보류 → 합격으로 덮으면 사유가 있어야 한다. `REINSPECTION_REASON` 은 열린 그룹이라 값은 대조하지 않는다(§1-5).
 */
export async function assertReinspectionReason(
  db: Db,
  inspectionRequestId: bigint,
  written: { resultId?: bigint; seqNo: number; judgmentCode: string | null; lotIds: readonly bigint[]; reasonCode: string | null | undefined },
): Promise<void> {
  if (written.reasonCode != null && written.reasonCode.trim() !== '') return;
  const others = (await judgedResultsOf(db, [inspectionRequestId])).filter((result) => result.resultId !== written.resultId);
  if (!reinspectionReasonRequired(others, written)) return;
  throw one(field('reinspectionReasonCode', REINSPECTION_REASON_REQUIRED, '불합격·보류 판정을 바꾸는 결과입니다 — 재검 사유를 고르세요.'));
}

export async function replaceMatchedLotsWithin(tx: Prisma.TransactionClient, inspectionResultId: bigint, lotIds: readonly bigint[]): Promise<void> {
  await tx.inspection_result_lot.deleteMany({ where: { inspection_result_id: inspectionResultId } });
  if (lotIds.length === 0) return;
  await tx.inspection_result_lot.createMany({ data: lotIds.map((lotId) => ({ inspection_result_id: inspectionResultId, lot_id: lotId })) });
}

/**
 * IQC 불량 기록의 LOT(R-10 · R12-1) — 요청이 LOT 하나를 가리키면(옛 요청) 그 LOT, 입하 LOT 요청이면 그 결과에 매칭된 LOT 이
 * 하나일 때만 그 LOT 이고 아니면 NULL 이다(결과 연결로 찾는다).
 */
export async function iqcDefectLotIdWithin(db: Db, inspectionResultId: bigint): Promise<bigint | null> {
  const result = await db.inspection_result.findUnique({
    where: { inspection_result_id: inspectionResultId },
    select: { inspection_request: { select: { lot_id: true } }, inspection_result_lot: { select: { lot_id: true }, take: 2 } },
  });
  if (result === null) return null;
  if (result.inspection_request.lot_id !== null) return result.inspection_request.lot_id;
  return result.inspection_result_lot.length === 1 ? result.inspection_result_lot[0].lot_id : null;
}

/** 매칭이 바뀐 결과의 IQC 불량 기록 LOT 을 다시 맞춘다. */
export async function syncIqcDefectLotWithin(tx: Prisma.TransactionClient, inspectionResultId: bigint): Promise<void> {
  const lotId = await iqcDefectLotIdWithin(tx, inspectionResultId);
  await tx.defect_record.updateMany({ where: { inspection_result_id: inspectionResultId, source_type_code: 'IQC' }, data: { lot_id: lotId } });
}

/** 이력(`inspection_request_event`)의 전·후 요약 — 화면이 「무엇이 바뀌었나」를 그린다. */
export async function resultSummaryWithin(tx: Prisma.TransactionClient, inspectionResultId: bigint): Promise<Prisma.InputJsonObject> {
  const row = await tx.inspection_result.findUniqueOrThrow({
    where: { inspection_result_id: inspectionResultId },
    select: {
      inspection_result_no: true, inspection_round: true, overall_judgment_code: true,
      inspected_qty: true, accepted_qty: true, rejected_qty: true, held_qty: true,
      inspection_result_lot: { select: { lot: { select: { lot_id: true, lot_no: true } } }, orderBy: { lot_id: 'asc' } },
    },
  });
  const lots = row.inspection_result_lot.map((match) => match.lot);
  return {
    inspectionResultNo: row.inspection_result_no,
    inspectionRound: row.inspection_round,
    overallJudgmentCode: row.overall_judgment_code,
    inspectedQty: Number(row.inspected_qty),
    acceptedQty: Number(row.accepted_qty),
    rejectedQty: Number(row.rejected_qty),
    heldQty: Number(row.held_qty),
    matchedLotIds: lots.map((lot) => Number(lot.lot_id)),
    matchedLotNos: lots.map((lot) => lot.lot_no),
  };
}

/** 입하 LOT 요청은 확정 전(대기·진행)에만 결과를 고친다(409) — 요청 행을 잠가 판정 확정과 엇갈리지 않게 한다. 전 요약을 돌려준다. */
export async function lockOpenInboundLotRequest(
  tx: Prisma.TransactionClient,
  inspectionRequestId: bigint,
  inspectionResultId: number,
): Promise<Prisma.InputJsonObject> {
  const [request] = await tx.$queryRaw<{ status_code: string }[]>`
    SELECT status_code FROM quality.inspection_request WHERE inspection_request_id = ${inspectionRequestId} FOR UPDATE`;
  assertRequestOpen(request.status_code);
  return resultSummaryWithin(tx, BigInt(inspectionResultId));
}

/** 매칭이 바뀌면 불량 기록의 LOT 도 다시 맞추고(R-10), 이력에 전·후 요약을 남긴다(R-11). */
export async function recordInboundLotUpdate(
  tx: Prisma.TransactionClient,
  inbound: InboundLotWrite,
  inspectionResultId: bigint,
  before: Prisma.InputJsonObject | undefined,
  actor: InspectionRequestEventActor,
): Promise<void> {
  if (inbound.matchedLotIds !== undefined) await syncIqcDefectLotWithin(tx, inspectionResultId);
  const result = await tx.inspection_result.findUniqueOrThrow({
    where: { inspection_result_id: inspectionResultId }, select: { inspection_request_id: true },
  });
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: result.inspection_request_id, eventTypeCode: 'RESULT_UPDATED', inspectionResultId, actor, at: new Date(),
    summaryBefore: before, summaryAfter: await resultSummaryWithin(tx, inspectionResultId),
  });
}

/** 이력의 행위자 — 계정 세션이 먼저, 없으면(단말) 귀속 작업자다(CHECK `num_nonnulls = 1`). */
export function eventActor(context: InspectionResultWriteContext, workerId: bigint | null): InspectionRequestEventActor {
  if (context.appUserId !== undefined) return { appUserId: context.appUserId };
  if (workerId === null) throw new Error('입하 LOT 검사 이력의 행위자가 없다 — 검사자를 먼저 푼다');
  return { workerId };
}
