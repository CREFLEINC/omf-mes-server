import { Prisma } from '@prisma/client';

/**
 * 계약 `InventoryAdjustment`·`InventoryAdjustmentLine` 으로 옮기는 자리. 등록·치환·전기 PR
 * 이 그대로 재사용한다.
 *
 * ⛔ 널이어도 **키를 생략하지 않는다** — `inventoryCountId`·`approvalRequestId`·
 * `adjustedAt`·`inventoryCountLineId`·`lotId`·`reasonCode` 전부 계약 `type` 에 `null` 이
 * 이미 있어 통과한다(`goods-issue-view.ts` 와 같은 판정).
 * ⛔ `inventoryTransactionLineId` 는 라인이 채우지만 응답에 안 싣는다 — 화면은 원장을
 * `GET /inventory/transactions?sourceDocumentTypeCode=INVENTORY_ADJUSTMENT&sourceDocumentId=`
 * 로 역조회한다(I-14.md §1-4).
 * ⛔ `erpMessageQueued` 는 담을 칸이 없어 늘 `false` 다(I-14.md §1-4 · 문의 134).
 */

export type InventoryAdjustmentRow = Prisma.inventory_adjustmentGetPayload<object>;
export type InventoryAdjustmentLineRow = Prisma.inventory_adjustment_lineGetPayload<object>;

export interface InventoryAdjustmentView {
  inventoryAdjustmentId: number;
  inventoryAdjustmentNo: string;
  inventoryCountId: number | null;
  reasonCode: string;
  statusCode: string;
  approvalRequestId: number | null;
  adjustedAt: string | null;
  erpMessageQueued: boolean;
}

export interface InventoryAdjustmentLineView {
  inventoryAdjustmentLineId: number;
  inventoryAdjustmentId: number;
  lineNo: number;
  locationId: number;
  itemId: number;
  lotId: number | null;
  adjustmentQty: number;
  uomId: number;
  reasonCode: string;
  inventoryCountLineId: number | null;
}

export interface InventoryAdjustmentDetail {
  inventoryAdjustment: InventoryAdjustmentView;
  lines: InventoryAdjustmentLineView[];
}

export function inventoryAdjustmentView(row: InventoryAdjustmentRow): InventoryAdjustmentView {
  return {
    inventoryAdjustmentId: Number(row.inventory_adjustment_id),
    inventoryAdjustmentNo: row.inventory_adjustment_no,
    inventoryCountId: id(row.inventory_count_id),
    reasonCode: row.reason_code,
    statusCode: row.status_code,
    approvalRequestId: id(row.approval_request_id),
    adjustedAt: row.adjusted_at === null ? null : row.adjusted_at.toISOString(),
    // 담을 칸이 없다(§1-4) — 파생값이라 늘 거짓이다.
    erpMessageQueued: false,
  };
}

export function inventoryAdjustmentLineView(row: InventoryAdjustmentLineRow): InventoryAdjustmentLineView {
  return {
    inventoryAdjustmentLineId: Number(row.inventory_adjustment_line_id),
    inventoryAdjustmentId: Number(row.inventory_adjustment_id),
    lineNo: row.line_no,
    locationId: Number(row.location_id),
    itemId: Number(row.item_id),
    lotId: id(row.lot_id),
    adjustmentQty: Number(row.adjustment_qty),
    uomId: Number(row.uom_id),
    reasonCode: row.reason_code,
    // 마이그 전 물리 칸 0 — I-14 PR ② 가 채운다(I-14.md §2-4).
    inventoryCountLineId: null,
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
