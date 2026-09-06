import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 계약 `PickingOrder`·`PickingLine` 으로 옮기는 자리. 라인의 **파생 8칸**이 여기서 난다
 * (`held`·`holdReasonCode` · 마스터 6칸 중 `itemCode`·`itemName`·`lotNo`·`locationCode`·
 * `expiryDate`·`manufacturedAt` · `pickSequenceRank`).
 *
 * ⛔ 널이어도 **키를 생략하지 않는다** — `assignedWorkerId`·`inventoryReservationId`·
 * `holdReasonCode`·`expiryDate`·`manufacturedAt`·`pickSequenceRank` 전부 계약이 `null` 을
 * 허용한 칸이다(`goods-issue-view.ts:77` 선례 · I-8.md R-20).
 */

export const PICKING_LINE_INCLUDE = {
  item: { select: { item_code: true, item_name: true, shelf_life_days: true } },
  lot: { select: { lot_no: true, expiry_date: true, manufactured_at: true } },
  location: { select: { location_code: true } },
} as const;

export type PickingOrderRow = Prisma.picking_orderGetPayload<object>;
export type PickingLineRow = Prisma.picking_lineGetPayload<{ include: typeof PICKING_LINE_INCLUDE }>;

export interface PickingOrderView {
  pickingOrderId: number;
  pickingOrderNo: string;
  pickingTypeCode: string;
  sourceDocumentTypeCode: string;
  sourceDocumentId: number;
  warehouseId: number;
  statusCode: string;
  assignedWorkerId: number | null;
}

export interface PickingLineView {
  pickingLineId: number;
  pickingOrderId: number;
  lineNo: number;
  itemId: number;
  lotId: number;
  locationId: number;
  plannedQty: number;
  pickedQty: number;
  uomId: number;
  inventoryReservationId: number | null;
  statusCode: string;
  held: boolean;
  holdReasonCode: string | null;
  itemCode: string;
  itemName: string;
  lotNo: string;
  locationCode: string;
  expiryDate: string | null;
  manufacturedAt: string | null;
  pickSequenceRank: number | null;
}

export interface PickingOrderDetail {
  pickingOrder: PickingOrderView;
  lines: PickingLineView[];
}

export function pickingOrderView(row: PickingOrderRow): PickingOrderView {
  return {
    pickingOrderId: Number(row.picking_order_id),
    pickingOrderNo: row.picking_order_no,
    pickingTypeCode: row.picking_type_code,
    sourceDocumentTypeCode: row.source_document_type_code,
    sourceDocumentId: Number(row.source_document_id),
    warehouseId: Number(row.warehouse_id),
    statusCode: row.status_code,
    assignedWorkerId: row.assigned_worker_id === null ? null : Number(row.assigned_worker_id),
  };
}

/**
 * `holdReasonCode` 는 **미해제 보류가 있을 때의 사유 하나**다 — 겹쳐 걸린 LOT 이면 `held_at`
 * 최신 것만 실린다(계약에 여러 사유를 담을 칸이 없다 · I-8.md R-24 ⓒ).
 * ⛔ `judgment_type_control.blocks_picking` 은 여기 안 섞는다 — 계약 `held` 는 `trace.lot_hold`
 * 파생뿐이라 차단 축이 둘로 갈린다(I-8.md R-17 · 알려둘 것 ⓝ).
 */
export function pickingLineView(
  row: PickingLineRow,
  holdReasonCode: string | null,
  pickSequenceRank: number | null,
): PickingLineView {
  return {
    pickingLineId: Number(row.picking_line_id),
    pickingOrderId: Number(row.picking_order_id),
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    locationId: Number(row.location_id),
    plannedQty: Number(row.planned_qty),
    pickedQty: Number(row.picked_qty),
    uomId: Number(row.uom_id),
    inventoryReservationId:
      row.inventory_reservation_id === null ? null : Number(row.inventory_reservation_id),
    statusCode: row.status_code,
    held: holdReasonCode !== null,
    holdReasonCode,
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    lotNo: row.lot.lot_no,
    locationCode: row.location.location_code,
    expiryDate: toDateString(row.lot.expiry_date),
    manufacturedAt: row.lot.manufactured_at === null ? null : row.lot.manufactured_at.toISOString(),
    pickSequenceRank,
  };
}

/** `pickSequenceRanks` 가 보는 것 — `PickingLineRow` 가 구조로 만족한다(단위 테스트가 이 모양만 짓는다). */
export interface RankLine {
  picking_line_id: bigint;
  item_id: bigint;
  line_no: number;
  item: { shelf_life_days: number | null };
  lot: { expiry_date: Date | null; manufactured_at: Date | null };
}

/**
 * 라인 → `pickSequenceRank`. **이 지시 «안»의 같은 품목 라인들 사이 순위**다(1 이 우선).
 * ⛔ 지시 밖 재고는 안 센다 — 응답이 라인 집합이라 담을 칸이 없다(I-8.md §8-3 · 문의 045 ⓒ).
 * 정렬 키가 널인 라인은 순위 매김에서 빠지고 **`null`** 이 된다(계약 ⌜정렬 근거가 없으면
 * 비어 온다 — 「1순위」가 아니다⌝ · 키 생략이 아니다 · I-8.md R-20). 동률은 `line_no` 로 고정한다.
 */
export function pickSequenceRanks(lines: readonly RankLine[]): Map<bigint, number | null> {
  const ranks = new Map<bigint, number | null>();
  const byItem = new Map<bigint, { line: RankLine; key: number }[]>();

  for (const line of lines) {
    ranks.set(line.picking_line_id, null);
    const key = sortKey(line);
    if (key === null) continue;
    const bucket = byItem.get(line.item_id);
    if (bucket === undefined) byItem.set(line.item_id, [{ line, key }]);
    else bucket.push({ line, key });
  }

  for (const bucket of byItem.values()) {
    bucket.sort((a, b) => a.key - b.key || a.line.line_no - b.line.line_no);
    bucket.forEach((entry, index) => ranks.set(entry.line.picking_line_id, index + 1));
  }
  return ranks;
}

/**
 * 유효기한 관리 품목(`shelf_life_days` 있음)은 FEFO(`lot.expiry_date`) · 아니면
 * FIFO(`lot.manufactured_at`). ⛔ `item.fifo_policy_code` 는 **안 본다** — NOT NULL 기본 `FIFO`
 * 라 오늘 언제나 참이고, 조건으로 걸면 계약이 적지 않은 셋째 갈래가 생긴다(I-8.md R-21).
 */
function sortKey(line: RankLine): number | null {
  const value =
    line.item.shelf_life_days === null ? line.lot.manufactured_at : line.lot.expiry_date;
  return value === null ? null : value.getTime();
}
