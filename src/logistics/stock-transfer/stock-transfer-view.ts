import { Prisma } from '@prisma/client';

/**
 * 계약 `StockTransfer`·`StockTransferLine` 으로 옮기는 자리. PR ②③④ 가 그대로 재사용한다.
 *
 * ⛔ `shippedAt`·`receivedAt`·`reasonCode` 는 계약이 `[string,null]` 로 널을 명시했다 —
 * 널이어도 키를 생략하지 않고 «싣는다»(`putaway-task-view.ts` 선례).
 * ⛔ `remarks`·`issueTransactionLineId`·`receiptTransactionLineId` 는 응답 스키마에 없다 —
 * 물리에는 있지만 담지 않는다(I-13.md §7-4).
 */

export type StockTransferRow = Prisma.stock_transferGetPayload<object>;
export type StockTransferLineRow = Prisma.stock_transfer_lineGetPayload<object>;

export interface StockTransferView {
  stockTransferId: number;
  stockTransferNo: string;
  transferTypeCode: string;
  fromBusinessUnitId: number;
  toBusinessUnitId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  requestedAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
  statusCode: string;
  reasonCode: string | null;
}

export interface StockTransferLineView {
  stockTransferLineId: number;
  stockTransferId: number;
  lineNo: number;
  itemId: number;
  lotId: number;
  requestedQty: number;
  shippedQty: number;
  receivedQty: number;
  uomId: number;
  fromLocationId: number;
  toLocationId: number;
  handlingUnitId: number | null;
}

export interface StockTransferDetail {
  stockTransfer: StockTransferView;
  lines: StockTransferLineView[];
}

export function stockTransferView(row: StockTransferRow): StockTransferView {
  return {
    stockTransferId: Number(row.stock_transfer_id),
    stockTransferNo: row.stock_transfer_no,
    transferTypeCode: row.transfer_type_code,
    fromBusinessUnitId: Number(row.from_business_unit_id),
    toBusinessUnitId: Number(row.to_business_unit_id),
    fromWarehouseId: Number(row.from_warehouse_id),
    toWarehouseId: Number(row.to_warehouse_id),
    requestedAt: row.requested_at.toISOString(),
    shippedAt: row.shipped_at === null ? null : row.shipped_at.toISOString(),
    receivedAt: row.received_at === null ? null : row.received_at.toISOString(),
    statusCode: row.status_code,
    reasonCode: row.reason_code,
  };
}

export function stockTransferLineView(row: StockTransferLineRow): StockTransferLineView {
  return {
    stockTransferLineId: Number(row.stock_transfer_line_id),
    stockTransferId: Number(row.stock_transfer_id),
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    requestedQty: Number(row.requested_qty),
    shippedQty: Number(row.shipped_qty),
    receivedQty: Number(row.received_qty),
    uomId: Number(row.uom_id),
    fromLocationId: Number(row.from_location_id),
    toLocationId: Number(row.to_location_id),
    // A4(`handling_unit_id`)는 PR ② 마이그가 세운다 — 물리 칸이 아직 없어 항상 널이다.
    handlingUnitId: null,
  };
}
