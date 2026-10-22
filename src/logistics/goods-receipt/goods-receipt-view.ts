import { Prisma } from '@prisma/client';

/**
 * 계약 `GoodsReceipt`·`GoodsReceiptLine` 으로 옮기는 자리.
 *
 * `erpMessageQueued` 는 구매입고 적재(`IF-GR-SEND`)가 있는지다 — 한도승인(특채) 건을 가르는 축이 없어 거짓으로
 * 고정했던 것(되돌림 §Z-9)을 특채 기록으로 가르게 되어 풀었다(장부 P-104).
 */

export type ReceiptRow = Prisma.goods_receiptGetPayload<object>;
export type ReceiptLineRow = Prisma.goods_receipt_lineGetPayload<{
  include: { putaway_task: { select: { putaway_task_id: true } } };
}>;

export interface GoodsReceiptView {
  goodsReceiptId: number;
  goodsReceiptNo: string;
  receiptTypeCode: string;
  plantId: number;
  warehouseId: number;
  receiptDatetime: string;
  statusCode: string;
  /**
   * ⛔ 값이 없으면 **칸째 뺀다.** `type` 에 `null` 이 있는데 `enum` 에는 없어 `null` 이
   * 계약 스스로를 통과하지 못한다 — 전 계약 16자리 중 하나다(되돌림 §Y-1 · 문의 5번).
   */
  sourceDocumentTypeCode?: string;
  sourceDocumentId: number | null;
  reasonCode: string | null;
  remarks: string | null;
  erpMessageQueued: boolean;
}

export interface GoodsReceiptLineView {
  goodsReceiptLineId: number;
  goodsReceiptId: number;
  lineNo: number;
  inboundReceiptLineId: number | null;
  itemId: number;
  lotId: number;
  receiptQty: number;
  uomId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  destinationLocationId: number;
  inventoryTransactionLineId: number | null;
  putawayTaskId: number | null;
  originalShipmentLotAllocationId: number | null;
}

export interface GoodsReceiptDetail {
  goodsReceipt: GoodsReceiptView;
  lines: GoodsReceiptLineView[];
}

export function receiptView(row: ReceiptRow, erpMessageQueued: boolean): GoodsReceiptView {
  return {
    goodsReceiptId: Number(row.goods_receipt_id),
    goodsReceiptNo: row.goods_receipt_no,
    receiptTypeCode: row.receipt_type_code,
    plantId: Number(row.plant_id),
    warehouseId: Number(row.warehouse_id),
    receiptDatetime: row.receipt_datetime.toISOString(),
    statusCode: row.status_code,
    ...(row.source_document_type_code === null
      ? {}
      : { sourceDocumentTypeCode: row.source_document_type_code }),
    sourceDocumentId: id(row.source_document_id),
    reasonCode: row.reason_code,
    remarks: row.remarks,
    erpMessageQueued,
  };
}

/**
 * ⭐ `putawayTaskId` 는 입고 응답이 실어 내리는 값이다 — 「화면은 이 값으로 바로 적치
 * 완료를 부른다」(계약). 라인마다 지시가 하나라 첫 건을 싣는다.
 */
export function receiptLineView(row: ReceiptLineRow): GoodsReceiptLineView {
  return {
    goodsReceiptLineId: Number(row.goods_receipt_line_id),
    goodsReceiptId: Number(row.goods_receipt_id),
    lineNo: row.line_no,
    inboundReceiptLineId: id(row.inbound_receipt_line_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    receiptQty: Number(row.receipt_qty),
    uomId: Number(row.uom_id),
    qualityStatusCode: row.quality_status_code,
    inventoryStatusCode: row.inventory_status_code,
    destinationLocationId: Number(row.destination_location_id),
    inventoryTransactionLineId: id(row.inventory_transaction_line_id),
    putawayTaskId:
      row.putaway_task.length === 0 ? null : Number(row.putaway_task[0].putaway_task_id),
    originalShipmentLotAllocationId: id(row.original_shipment_lot_allocation_id),
  };
}

export const LINE_INCLUDE = {
  putaway_task: { select: { putaway_task_id: true } },
} as const;

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
