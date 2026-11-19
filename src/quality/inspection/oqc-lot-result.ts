import { Prisma } from '@prisma/client';

import { iqcLotJudgments } from './iqc-overall-judgment';

/**
 * 출하 OQC 새 흐름(피처 010 · research R-5) — 결과는 피킹 LOT 매칭·판정만이고, LOT 마다 마지막 매칭 결과가 판정이다.
 * 결과는 작성중(DRAFT)으로 쌓였다가 출하 완료 때 한꺼번에 확정된다(확정 버튼 없음).
 *
 * ⭐ 새 흐름 의뢰 = OQC · 대상 `SHIPMENT_REQUEST` · `lot_id` 없음(편성 때 품목별로 서는 의뢰). 배포 전 결과(매칭 행 없음)가 있는
 *    의뢰도 새 흐름으로 이어진다 — 확정된 옛 결과는 그 품목 피킹 LOT 전부를 매칭한 것으로 본다(spec Edge).
 */
export type OqcLotStatus = 'NOT_REQUIRED' | 'SKIPPED' | 'NOT_INSPECTED' | 'ACCEPTED' | 'REJECTED' | 'HELD';

export const OQC = 'OQC';
export const SHIPMENT_REQUEST_TARGET = 'SHIPMENT_REQUEST';
const CONFIRMED = 'CONFIRMED';
const SKIPPED = 'SKIPPED';
const CANCELLED = 'CANCELLED';
const REPLACED = 'REPLACED';

type Db = Pick<Prisma.TransactionClient, 'shipment_request_lot' | 'inspection_request' | 'inspection_result'>;

export interface OqcLotFacts {
  lotId: bigint;
  inspectionRequired: boolean;
}

export interface OqcResultFacts {
  requestId: bigint;
  seqNo: number;
  judgmentCode: string | null;
  statusCode: string;
  lotIds: readonly bigint[];
  /** 판정 근거 표시용(PDA 「OQC 결과 n · 시각」) — 없으면 근거를 싣지 않는다. */
  result?: OqcDecidingResult;
}

/** 한 LOT 의 판정을 정한 결과 — 번호·회차(의뢰 안 순번)·검사 시각. */
export interface OqcDecidingResult {
  inspectionResultId: bigint;
  resultNo: string;
  round: number;
  inspectedAt: Date;
}

/** LOT 판정과 그 근거 결과(검사 불필요·생략·미검사는 근거 없음). */
export interface OqcLotDecision {
  status: OqcLotStatus;
  result: OqcDecidingResult | null;
}

/** 새 흐름 의뢰인가 — 품목별 헤더 대상 OQC. */
export function isShipmentOqc(row: { inspection_type_code: string; target_type_code: string; lot_id: bigint | null }): boolean {
  return row.inspection_type_code === OQC && row.target_type_code === SHIPMENT_REQUEST_TARGET && row.lot_id === null;
}

/**
 * 한 지시서·품목 묶음의 살아 있는 피킹 LOT 판정. `lots` 는 교체되지 않은 피킹 LOT 이다(교체된 LOT 은 대상 밖 — US3-5).
 * 위에서부터: 검사 불필요 → `NOT_REQUIRED` · 생략된 의뢰 → `SKIPPED` · 마지막 매칭 결과의 판정 · 없으면 `NOT_INSPECTED`.
 */
export function oqcLotStatuses(
  lots: readonly OqcLotFacts[],
  group: { skipped: boolean; results: readonly OqcResultFacts[] },
): Map<bigint, OqcLotStatus> {
  return new Map([...oqcLotDecisions(lots, group)].map(([lotId, decision]) => [lotId, decision.status]));
}

/** `oqcLotStatuses` 와 같은 판정에 그 판정을 정한 결과(근거)를 함께 낸다 — 판정은 이 함수 하나가 한다. */
export function oqcLotDecisions(
  lots: readonly OqcLotFacts[],
  group: { skipped: boolean; results: readonly OqcResultFacts[] },
): Map<bigint, OqcLotDecision> {
  const live = lots.map((lot) => lot.lotId);
  // 의뢰 순서 → 순번 — 의뢰가 둘이어도 «마지막»이 하나로 정해진다.
  const ordered = [...group.results].sort((a, b) => (a.requestId === b.requestId ? a.seqNo - b.seqNo : a.requestId < b.requestId ? -1 : 1));
  const judged = ordered.map((result, index) => ({
    resultId: BigInt(index + 1),
    seqNo: index + 1,
    judgmentCode: result.judgmentCode,
    lotIds: result.lotIds.length === 0 && result.statusCode === CONFIRMED ? live : result.lotIds,
    source: result,
  }));
  const byLot = iqcLotJudgments(judged);
  const decisions = new Map<bigint, OqcLotDecision>();
  for (const lot of lots) {
    if (!lot.inspectionRequired) decisions.set(lot.lotId, { status: 'NOT_REQUIRED', result: null });
    else if (group.skipped) decisions.set(lot.lotId, { status: 'SKIPPED', result: null });
    else {
      const used = byLot.get(lot.lotId)?.used;
      const status = (used?.judgmentCode as OqcLotStatus | null | undefined) ?? 'NOT_INSPECTED';
      decisions.set(lot.lotId, { status, result: status === 'NOT_INSPECTED' ? null : used?.source.result ?? null });
    }
  }
  return decisions;
}

/** 지시서의 OQC 묶음 열쇠 — (지시서, 품목). */
const groupKey = (shipmentRequestId: bigint, itemId: bigint): string => `${String(shipmentRequestId)}:${String(itemId)}`;

/**
 * 지시서들의 살아 있는 피킹 LOT 마다 OQC 판정 — 피킹 LOT 행 id → 판정. 지시서 조회·PDA·출하 완료 관문이 같은 함수를 쓴다.
 * ⭐ 다른 지시서의 결과는 보지 않는다(FR-011) — 의뢰가 지시서·품목 단위라 모집단에 없다.
 */
export async function oqcLotStatusesOf(db: Db, shipmentRequestIds: readonly bigint[]): Promise<Map<bigint, OqcLotStatus>> {
  return new Map([...(await oqcLotDecisionsOf(db, shipmentRequestIds))].map(([id, decision]) => [id, decision.status]));
}

/** `oqcLotStatusesOf` 와 같은 판정 + 근거 결과 — 피킹 LOT 행 id → 판정·근거. 지시서 조회(PDA 「OQC 결과 n」)가 쓴다. */
export async function oqcLotDecisionsOf(db: Db, shipmentRequestIds: readonly bigint[]): Promise<Map<bigint, OqcLotDecision>> {
  if (shipmentRequestIds.length === 0) return new Map();
  const [lots, requests] = await Promise.all([
    db.shipment_request_lot.findMany({
      where: { status_code: { not: REPLACED }, shipment_request_line: { shipment_request_id: { in: [...shipmentRequestIds] } } },
      select: {
        shipment_request_lot_id: true, lot_id: true,
        shipment_request_line: { select: { shipment_request_id: true, item_id: true, shipping_inspection_required: true } },
      },
    }),
    db.inspection_request.findMany({
      where: {
        inspection_type_code: OQC, target_type_code: SHIPMENT_REQUEST_TARGET, lot_id: null,
        target_id: { in: [...shipmentRequestIds] }, status_code: { not: CANCELLED },
      },
      select: {
        inspection_request_id: true, target_id: true, item_id: true, status_code: true,
        inspection_result: {
          select: {
            inspection_result_id: true, inspection_result_no: true, inspected_at: true,
            inspection_round: true, overall_judgment_code: true, status_code: true, inspection_result_lot: { select: { lot_id: true } },
          },
        },
      },
    }),
  ]);
  const groups = new Map<string, { skipped: boolean; results: OqcResultFacts[] }>();
  for (const request of requests) {
    const key = groupKey(request.target_id, request.item_id);
    const group = groups.get(key) ?? { skipped: false, results: [] };
    group.skipped ||= request.status_code === SKIPPED;
    group.results.push(...request.inspection_result.map((result) => ({
      requestId: request.inspection_request_id, seqNo: result.inspection_round, judgmentCode: result.overall_judgment_code,
      statusCode: result.status_code, lotIds: result.inspection_result_lot.map((match) => match.lot_id),
      result: {
        inspectionResultId: result.inspection_result_id, resultNo: result.inspection_result_no,
        round: result.inspection_round, inspectedAt: result.inspected_at,
      },
    })));
    groups.set(key, group);
  }
  const byGroup = new Map<string, typeof lots>();
  for (const lot of lots) {
    const key = groupKey(lot.shipment_request_line.shipment_request_id, lot.shipment_request_line.item_id);
    byGroup.set(key, [...(byGroup.get(key) ?? []), lot]);
  }
  const decisions = new Map<bigint, OqcLotDecision>();
  for (const [key, members] of byGroup) {
    const judged = oqcLotDecisions(
      members.map((lot) => ({ lotId: lot.lot_id, inspectionRequired: lot.shipment_request_line.shipping_inspection_required })),
      groups.get(key) ?? { skipped: false, results: [] },
    );
    for (const lot of members) decisions.set(lot.shipment_request_lot_id, judged.get(lot.lot_id) ?? { status: 'NOT_INSPECTED', result: null });
  }
  return decisions;
}

/**
 * 한 피킹 LOT 의 판정을 정한 결과 — 그 지시서·품목 의뢰들의 결과 중 그 LOT 을 매칭한 마지막 것(옛 확정 결과는 전부 매칭).
 * 교체(피처 010 R-4)가 근거 결과·부적합의 의뢰로 쓴다. 매칭한 결과가 없으면 `null`.
 */
export async function oqcLotDecidingResult(
  db: Db,
  shipmentRequestId: bigint,
  itemId: bigint,
  lotId: bigint,
): Promise<{ inspectionResultId: bigint; inspectionRequestId: bigint; judgmentCode: string | null } | null> {
  const requests = await db.inspection_request.findMany({
    where: {
      inspection_type_code: OQC, target_type_code: SHIPMENT_REQUEST_TARGET, lot_id: null,
      target_id: shipmentRequestId, item_id: itemId, status_code: { not: CANCELLED },
    },
    orderBy: { inspection_request_id: 'asc' },
    select: {
      inspection_request_id: true,
      inspection_result: {
        orderBy: { inspection_round: 'asc' },
        select: { inspection_result_id: true, overall_judgment_code: true, status_code: true, inspection_result_lot: { select: { lot_id: true } } },
      },
    },
  });
  const matching = requests.flatMap((request) => request.inspection_result
    .filter((result) => result.inspection_result_lot.some((match) => match.lot_id === lotId)
      || (result.inspection_result_lot.length === 0 && result.status_code === CONFIRMED))
    .map((result) => ({ inspectionResultId: result.inspection_result_id, inspectionRequestId: request.inspection_request_id, judgmentCode: result.overall_judgment_code })));
  return matching.at(-1) ?? null;
}
