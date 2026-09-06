import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 계약 `Asn`·`AsnLine` 으로 옮기는 자리.
 *
 * ⛔ `orderedQty`·`receivedQty` 는 `asn_line` 의 컬럼이 아니다 — 그 라인이 가리키는
 * `purchase_order_line` 을 조인해 내리는 파생값이다(계약 `x-internal-note`, I-3.md §2-1).
 * `purchaseOrderLineId` 가 비면(무발주) 둘 다 널이다 — 키는 생략하지 않는다.
 */

export type AsnRow = Prisma.asnGetPayload<object>;
export type AsnLineRow = Prisma.asn_lineGetPayload<{ include: { purchase_order_line: true } }>;

export interface AsnView {
  asnId: number;
  asnNo: string;
  supplierId: number;
  plantId: number;
  expectedArrivalDate: string;
  deliveryNoteNo: string | null;
  statusCode: string;
  remarks: string | null;
}

export interface AsnLineView {
  asnLineId: number;
  asnId: number;
  lineNo: number;
  purchaseOrderLineId: number | null;
  itemId: number;
  expectedQty: number;
  uomId: number;
  supplierLotNo: string | null;
  orderedQty: number | null;
  receivedQty: number | null;
}

export interface AsnDetail {
  asn: AsnView;
  lines: AsnLineView[];
}

export function asnView(row: AsnRow): AsnView {
  return {
    asnId: Number(row.asn_id),
    asnNo: row.asn_no,
    supplierId: Number(row.supplier_id),
    plantId: Number(row.plant_id),
    expectedArrivalDate: toDateString(row.expected_arrival_date) as string,
    deliveryNoteNo: row.delivery_note_no,
    statusCode: row.status_code,
    remarks: row.remarks,
  };
}

export function asnLineView(row: AsnLineRow): AsnLineView {
  const po = row.purchase_order_line;
  return {
    asnLineId: Number(row.asn_line_id),
    asnId: Number(row.asn_id),
    lineNo: row.line_no,
    purchaseOrderLineId: id(row.purchase_order_line_id),
    itemId: Number(row.item_id),
    expectedQty: Number(row.expected_qty),
    uomId: Number(row.uom_id),
    supplierLotNo: row.supplier_lot_no,
    orderedQty: po === null ? null : Number(po.ordered_qty),
    receivedQty: po === null ? null : Number(po.received_qty),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
