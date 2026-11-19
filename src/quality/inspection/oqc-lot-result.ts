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
  const live = lots.map((lot) => lot.lotId);
  // 의뢰 순서 → 순번 — 의뢰가 둘이어도 «마지막»이 하나로 정해진다.
  const ordered = [...group.results].sort((a, b) => (a.requestId === b.requestId ? a.seqNo - b.seqNo : a.requestId < b.requestId ? -1 : 1));
  const judged = ordered.map((result, index) => ({
    resultId: BigInt(index + 1),
    seqNo: index + 1,
    judgmentCode: result.judgmentCode,
    lotIds: result.lotIds.length === 0 && result.statusCode === CONFIRMED ? live : result.lotIds,
  }));
  const byLot = iqcLotJudgments(judged);
  const statuses = new Map<bigint, OqcLotStatus>();
  for (const lot of lots) {
    if (!lot.inspectionRequired) statuses.set(lot.lotId, 'NOT_REQUIRED');
    else if (group.skipped) statuses.set(lot.lotId, 'SKIPPED');
    else statuses.set(lot.lotId, (byLot.get(lot.lotId)?.used.judgmentCode as OqcLotStatus | null) ?? 'NOT_INSPECTED');
  }
  return statuses;
}

/** 지시서의 OQC 묶음 열쇠 — (지시서, 품목). */
const groupKey = (shipmentRequestId: bigint, itemId: bigint): string => `${String(shipmentRequestId)}:${String(itemId)}`;

/**
 * 지시서들의 살아 있는 피킹 LOT 마다 OQC 판정 — 피킹 LOT 행 id → 판정. 지시서 조회·PDA·출하 완료 관문이 같은 함수를 쓴다.
 * ⭐ 다른 지시서의 결과는 보지 않는다(FR-011) — 의뢰가 지시서·품목 단위라 모집단에 없다.
 */
export async function oqcLotStatusesOf(db: Db, shipmentRequestIds: readonly bigint[]): Promise<Map<bigint, OqcLotStatus>> {
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
          select: { inspection_round: true, overall_judgment_code: true, status_code: true, inspection_result_lot: { select: { lot_id: true } } },
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
    })));
    groups.set(key, group);
  }
  const byGroup = new Map<string, typeof lots>();
  for (const lot of lots) {
    const key = groupKey(lot.shipment_request_line.shipment_request_id, lot.shipment_request_line.item_id);
    byGroup.set(key, [...(byGroup.get(key) ?? []), lot]);
  }
  const statuses = new Map<bigint, OqcLotStatus>();
  for (const [key, members] of byGroup) {
    const judged = oqcLotStatuses(
      members.map((lot) => ({ lotId: lot.lot_id, inspectionRequired: lot.shipment_request_line.shipping_inspection_required })),
      groups.get(key) ?? { skipped: false, results: [] },
    );
    for (const lot of members) statuses.set(lot.shipment_request_lot_id, judged.get(lot.lot_id) ?? 'NOT_INSPECTED');
  }
  return statuses;
}
