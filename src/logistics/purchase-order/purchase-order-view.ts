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
  /** ERP 발주유형(PO_TYPE_CD)·구매그룹(PUR_GRP_CD)·입출고유형(IO_TYPE_CD) — 계약 밖 칸(장부 P-75). */
  erpOrderTypeCode: string | null;
  erpPurchaseGroupCode: string | null;
  erpIoTypeCode: string | null;
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
  /** ERP 입고창고(SL_CD)·ERP 가 이 라인을 취소한 시각 — 계약 밖 칸(장부 P-75). */
  erpStorageLocationCode: string | null;
  cancelledAt: string | null;
  /** 외자 발주 라인의 ERP 통관번호·순번·받은 시각(장부 P-143) — 계약 밖 칸. 받기 전·외자가 아니면 널. */
  erpCustomsClearanceNo: string | null;
  erpCustomsClearanceSeq: number | null;
  erpCustomsClearanceFetchedAt: string | null;
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
    orderDate: toDateString(row.order_date) as string,
    expectedReceiptDate: toDateString(row.expected_receipt_date),
    statusCode: row.status_code,
    approvalRequestId: id(row.approval_request_id),
    erpOrderTypeCode: row.erp_order_type_code,
    erpPurchaseGroupCode: row.erp_purchase_group_code,
    erpIoTypeCode: row.erp_io_type_code,
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
    erpStorageLocationCode: row.erp_storage_location_code,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    erpCustomsClearanceNo: row.erp_customs_clearance_no,
    erpCustomsClearanceSeq: row.erp_customs_clearance_seq,
    erpCustomsClearanceFetchedAt: row.erp_customs_clearance_fetched_at?.toISOString() ?? null,
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
