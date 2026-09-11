import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 계약 `InboundReceipt`·`InboundReceiptLine` 으로 옮기는 자리.
 * ⛔ 값이 없어도 **키를 생략하지 않는다**(`lotId` 포함) — `type: [x, null]` 이라 널이 계약을
 * 통과한다. ⛔ `businessDate`·`occurredAt` 은 응답 스키마에 칸이 없다(I-3.md §2-5).
 */

export type InboundReceiptRow = Prisma.inbound_receiptGetPayload<object>;
export type InboundReceiptLineRow = Prisma.inbound_receipt_lineGetPayload<object>;

export interface InboundReceiptView {
  inboundReceiptId: number;
  inboundReceiptNo: string;
  supplierId: number;
  plantId: number;
  receiptDatetime: string;
  deliveryNoteNo: string | null;
  vehicleNo: string | null;
  dockLocationId: number | null;
  exceptionTypeCode: string | null;
  exceptionReason: string | null;
  approvalRequestId: number | null;
  statusCode: string;
  receivedBy: number | null;
  remarks: string | null;
}

export interface InboundReceiptLineView {
  inboundReceiptLineId: number;
  inboundReceiptId: number;
  lineNo: number;
  purchaseOrderLineId: number | null;
  asnLineId: number | null;
  itemId: number;
  receivedQty: number;
  uomId: number;
  packageCount: number | null;
  supplierLotNo: string | null;
  supplierLotMissing: boolean;
  supplierLotLabelAttached: boolean;
  substituteLotReasonCode: string | null;
  manufacturedDate: string | null;
  expiryDate: string | null;
  inspectionRequired: boolean;
  statusCode: string;
  lotId: number | null;
}

export interface InboundReceiptDetail {
  inboundReceipt: InboundReceiptView;
  lines: InboundReceiptLineView[];
}

export function inboundReceiptView(row: InboundReceiptRow): InboundReceiptView {
  return {
    inboundReceiptId: Number(row.inbound_receipt_id),
    inboundReceiptNo: row.inbound_receipt_no,
    supplierId: Number(row.supplier_id),
    plantId: Number(row.plant_id),
    receiptDatetime: row.receipt_datetime.toISOString(),
    deliveryNoteNo: row.delivery_note_no,
    vehicleNo: row.vehicle_no,
    dockLocationId: id(row.dock_location_id),
    exceptionTypeCode: row.exception_type_code,
    exceptionReason: row.exception_reason,
    approvalRequestId: id(row.approval_request_id),
    statusCode: row.status_code,
    receivedBy: id(row.received_by),
    remarks: row.remarks,
  };
}

export function inboundReceiptLineView(row: InboundReceiptLineRow): InboundReceiptLineView {
  return {
    inboundReceiptLineId: Number(row.inbound_receipt_line_id),
    inboundReceiptId: Number(row.inbound_receipt_id),
    lineNo: row.line_no,
    purchaseOrderLineId: id(row.purchase_order_line_id),
    asnLineId: id(row.asn_line_id),
    itemId: Number(row.item_id),
    receivedQty: Number(row.received_qty),
    uomId: Number(row.uom_id),
    packageCount: row.package_count,
    supplierLotNo: row.supplier_lot_no,
    supplierLotMissing: row.supplier_lot_missing,
    supplierLotLabelAttached: row.supplier_lot_label_attached,
    substituteLotReasonCode: row.substitute_lot_reason_code,
    manufacturedDate: toDateString(row.manufactured_date),
    expiryDate: toDateString(row.expiry_date),
    inspectionRequired: row.inspection_required,
    statusCode: row.status_code,
    lotId: id(row.lot_id),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
