import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 계약 `PurchaseOrder`·`PurchaseOrderLine` 으로 옮기는 자리.
 *
 * ⛔ `erpPurchaseOrderNo`·`approvalRequestId` 는 값이 없어도 **키를 생략하지 않는다** —
 * `type: [x, null]` 이라 널이 계약을 통과한다(입고의 `omitEmpty` 자리와 반대 — I-2.md §6-4).
 */

export type PurchaseOrderRow = Prisma.purchase_orderGetPayload<object>;
export type PurchaseOrderLineRow = Prisma.purchase_order_lineGetPayload<object>;

export interface PurchaseOrderView {
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  businessUnitId: number;
  plantId: number;
  orderDate: string;
  expectedReceiptDate: string | null;
  statusCode: string;
  approvalRequestId: number | null;
}

export interface PurchaseOrderLineView {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  lineNo: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
  receivedQty: number;
  toleranceOverQty: number;
  toleranceUnderQty: number;
}

export interface PurchaseOrderDetail {
  purchaseOrder: PurchaseOrderView;
  lines: PurchaseOrderLineView[];
}

export function purchaseOrderView(row: PurchaseOrderRow): PurchaseOrderView {
  return {
    purchaseOrderId: Number(row.purchase_order_id),
    purchaseOrderNo: row.purchase_order_no,
    erpPurchaseOrderNo: row.erp_purchase_order_no,
    supplierId: Number(row.supplier_id),
    businessUnitId: Number(row.business_unit_id),
    plantId: Number(row.plant_id),
    orderDate: row.order_date.toISOString().slice(0, 10),
    expectedReceiptDate: toDateString(row.expected_receipt_date),
    statusCode: row.status_code,
    approvalRequestId: id(row.approval_request_id),
  };
}

/** `tolerance*Qty` 는 `DEFAULT 0` 이라 생략된 적이 없다 — Decimal 0 을 그대로 낸다(널 아님). */
export function purchaseOrderLineView(row: PurchaseOrderLineRow): PurchaseOrderLineView {
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(row.purchase_order_id),
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    orderedQty: Number(row.ordered_qty),
    uomId: Number(row.uom_id),
    receivedQty: Number(row.received_qty),
    toleranceOverQty: Number(row.tolerance_over_qty),
    toleranceUnderQty: Number(row.tolerance_under_qty),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
