import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 입하 예정 한 줄(계약 사본 `InboundScheduleLine` — 장부 P-77). P/O 라인 하나와 그 헤더 칸.
 *
 * ⛔ 「다 들어왔는가」는 `received_qty >= ordered_qty` 하나로 본다 — 부족 허용치
 * (`tolerance_under_qty`)를 빼지 않는다. P/O 목록 `openOnly` 와 같은 기준이다(I-2.md §7-4 ·
 * W-01-09 §3 이 진행의 분모를 `ordered_qty` 로 적었다). 입하는 그 뒤에도 초과 허용치까지
 * 더 받는다(`inbound-receipt.service.ts` 의 `room`) — 그래서 남은 수량은 0 에서 자른다.
 */

export type PurchaseOrderLineScheduleRow = Prisma.purchase_order_lineGetPayload<{
  include: { purchase_order: true };
}>;

export type ReceiptStatusCode = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED';

export interface PurchaseOrderLineSchedule {
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  plantId: number;
  orderDate: string;
  expectedReceiptDate: string | null;
  /** 헤더 상태 — `PurchaseOrder.statusCode` 와 같다. */
  statusCode: string;
  purchaseOrderLineId: number;
  lineNo: number;
  itemId: number;
  uomId: number;
  orderedQty: number;
  receivedQty: number;
  /** 파생 — 발주 − 누적 입하. 초과 입하면 0. */
  remainingQty: number;
  toleranceOverQty: number;
  toleranceUnderQty: number;
  erpStorageLocationCode: string | null;
  cancelledAt: string | null;
  /** 파생 — 수량만 본다. 취소는 `cancelledAt` 으로 따로 본다. */
  receiptStatusCode: ReceiptStatusCode;
}

/** `Decimal` 로 판정한다 — `Number()` 로 접은 뒤 비교하면 `Decimal(20,6)` 끝자리에서 갈린다. */
export function receiptStatusOf(
  orderedQty: Prisma.Decimal,
  receivedQty: Prisma.Decimal,
): ReceiptStatusCode {
  if (receivedQty.greaterThanOrEqualTo(orderedQty)) return 'COMPLETED';
  return receivedQty.greaterThan(0) ? 'PARTIAL' : 'NOT_STARTED';
}

export function remainingQtyOf(orderedQty: Prisma.Decimal, receivedQty: Prisma.Decimal): number {
  const remaining = orderedQty.minus(receivedQty);
  return remaining.greaterThan(0) ? Number(remaining) : 0;
}

export function purchaseOrderLineSchedule(
  row: PurchaseOrderLineScheduleRow,
): PurchaseOrderLineSchedule {
  const header = row.purchase_order;
  return {
    purchaseOrderId: Number(header.purchase_order_id),
    purchaseOrderNo: header.purchase_order_no,
    erpPurchaseOrderNo: header.erp_purchase_order_no,
    supplierId: Number(header.supplier_id),
    plantId: Number(header.plant_id),
    orderDate: toDateString(header.order_date) as string,
    expectedReceiptDate: toDateString(header.expected_receipt_date),
    statusCode: header.status_code,
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    uomId: Number(row.uom_id),
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    remainingQty: remainingQtyOf(row.ordered_qty, row.received_qty),
    toleranceOverQty: Number(row.tolerance_over_qty),
    toleranceUnderQty: Number(row.tolerance_under_qty),
    erpStorageLocationCode: row.erp_storage_location_code,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    receiptStatusCode: receiptStatusOf(row.ordered_qty, row.received_qty),
  };
}
