import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { toDateString } from '../../common/master';

/**
 * 입하 초과분 잇기(장부 P-96) — 한 LOT 의 일부를 P/O 라인에 넣지 않고 남긴 몫을, ERP 가 만든 추가 P/O 라인에 잇는다.
 * 계약 사본에 없는 경로라 질의·본문을 여기서 손으로 검사한다(가드가 보지 않는다). 오류 모양은 가드와 같다.
 */

export interface InboundExcessQuery {
  /** 기본 `false` — 아직 안 이어진 초과분만. */
  linked: boolean;
  plantId?: bigint;
  supplierId?: bigint;
  itemId?: bigint;
  page?: number;
  size?: number;
}

const INT64_MAX = 2n ** 63n - 1n;
const ID_FIELDS = ['plantId', 'supplierId', 'itemId'] as const;
const PAGE_FIELDS = ['page', 'size'] as const;

export function parseExcessQuery(raw: Record<string, unknown>): InboundExcessQuery {
  const errors: ErrorItem[] = [];
  const parsed: InboundExcessQuery = { linked: false };
  for (const name of ID_FIELDS) {
    if (raw[name] === undefined) continue;
    const value = readId(raw[name]);
    if (value === undefined) errors.push(invalid(name, '양의 정수여야 합니다.'));
    else parsed[name] = value;
  }
  for (const name of PAGE_FIELDS) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value)) parsed[name] = Number(value);
    else errors.push(invalid(name, '1 이상의 정수여야 합니다.'));
  }
  if (raw.linked !== undefined) {
    if (raw.linked === 'true' || raw.linked === 'false') parsed.linked = raw.linked === 'true';
    else errors.push(invalid('linked', 'true 나 false 여야 합니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return parsed;
}

/** 경로의 id — 틀리면 400 field `INVALID`. */
export function parseExcessId(raw: string): bigint {
  const value = readId(raw);
  if (value === undefined) throw new ContractException(HttpStatus.BAD_REQUEST, [invalid('inboundReceiptExcessId', '양의 정수여야 합니다.')]);
  return value;
}

/** `:link` 본문 — `{ purchaseOrderLineId }`. JSON 숫자로 온다. */
export function parseLinkBody(body: unknown): bigint {
  const value = (body as { purchaseOrderLineId?: unknown } | null)?.purchaseOrderLineId;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  const code = value === undefined ? ERROR_CODE.REQUIRED : ERROR_CODE.INVALID;
  throw new ContractException(HttpStatus.BAD_REQUEST, [field('purchaseOrderLineId', code, '양의 정수여야 합니다.')]);
}

function readId(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return undefined;
  const id = BigInt(value);
  return id <= INT64_MAX ? id : undefined;
}

function invalid(name: string, message: string): ErrorItem {
  return field(name, ERROR_CODE.INVALID, message);
}

const ORDER_LINE_INCLUDE = {
  purchase_order: { select: { purchase_order_id: true, purchase_order_no: true, erp_purchase_order_no: true } },
} satisfies Prisma.purchase_order_lineInclude;

export const EXCESS_INCLUDE = {
  purchase_order_line: { include: ORDER_LINE_INCLUDE },
  inbound_receipt_line: {
    include: {
      inbound_receipt: { include: { partner: { select: { partner_code: true, partner_name: true } } } },
      item: { select: { item_code: true, item_name: true } },
      uom: { select: { uom_code: true } },
      lot: { select: { lot_no: true } },
      purchase_order_line: { include: ORDER_LINE_INCLUDE },
    },
  },
} satisfies Prisma.inbound_receipt_excessInclude;

export type ExcessRow = Prisma.inbound_receipt_excessGetPayload<{ include: typeof EXCESS_INCLUDE }>;
type OrderLineRow = Prisma.purchase_order_lineGetPayload<{ include: typeof ORDER_LINE_INCLUDE }>;

interface OrderLineRef {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  lineNo: number;
}

export interface InboundExcessView {
  inboundReceiptExcessId: number;
  excessQty: number;
  linkedAt: string | null;
  /** 이어진 추가 P/O 라인. 안 이어졌으면 `null`. */
  linkedOrderLine: OrderLineRef | null;
  inboundReceiptId: number;
  inboundReceiptNo: string;
  receiptDatetime: string;
  inboundReceiptLineId: number;
  lineNo: number;
  /** 줄 전체 수량 — LOT 의 처음 수량이다. */
  receivedQty: number;
  /** 이 줄이 처음 연결된 P/O 라인(초과분을 뺀 몫이 들어간 쪽). */
  sourceOrderLine: OrderLineRef | null;
  plantId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  uomId: number;
  uomCode: string;
  lotId: number | null;
  lotNo: string | null;
}

export function excessView(row: ExcessRow): InboundExcessView {
  const line = row.inbound_receipt_line;
  const receipt = line.inbound_receipt;
  return {
    inboundReceiptExcessId: Number(row.inbound_receipt_excess_id),
    excessQty: Number(row.excess_qty),
    linkedAt: row.linked_at?.toISOString() ?? null,
    linkedOrderLine: orderLineRef(row.purchase_order_line),
    inboundReceiptId: Number(receipt.inbound_receipt_id),
    inboundReceiptNo: receipt.inbound_receipt_no,
    receiptDatetime: receipt.receipt_datetime.toISOString(),
    inboundReceiptLineId: Number(line.inbound_receipt_line_id),
    lineNo: line.line_no,
    receivedQty: Number(line.received_qty),
    sourceOrderLine: orderLineRef(line.purchase_order_line),
    plantId: Number(receipt.plant_id),
    supplierId: Number(receipt.supplier_id),
    supplierCode: receipt.partner.partner_code,
    supplierName: receipt.partner.partner_name,
    itemId: Number(line.item_id),
    itemCode: line.item.item_code,
    itemName: line.item.item_name,
    uomId: Number(line.uom_id),
    uomCode: line.uom.uom_code,
    lotId: line.lot_id === null ? null : Number(line.lot_id),
    lotNo: line.lot?.lot_no ?? null,
  };
}

function orderLineRef(row: OrderLineRow | null): OrderLineRef | null {
  if (row === null) return null;
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(row.purchase_order.purchase_order_id),
    purchaseOrderNo: row.purchase_order.purchase_order_no,
    erpPurchaseOrderNo: row.purchase_order.erp_purchase_order_no,
    lineNo: row.line_no,
  };
}

/** 이을 수 있는 P/O 라인 후보. 남은 수량이 초과분과 같으면 `exactMatch` 다. */
export interface ExcessCandidateView extends OrderLineRef {
  orderDate: string;
  expectedReceiptDate: string | null;
  orderedQty: number;
  receivedQty: number;
  /** 발주 + 초과 허용치 − 받은 수량 — 이만큼까지 이을 수 있다. */
  roomQty: number;
  exactMatch: boolean;
}

export type CandidateRow = Prisma.purchase_order_lineGetPayload<{
  include: { purchase_order: true };
}>;

export function roomOf(row: { ordered_qty: Prisma.Decimal; tolerance_over_qty: Prisma.Decimal; received_qty: Prisma.Decimal }): Prisma.Decimal {
  return row.ordered_qty.plus(row.tolerance_over_qty).minus(row.received_qty);
}

export function candidateView(row: CandidateRow, excessQty: Prisma.Decimal): ExcessCandidateView {
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(row.purchase_order_id),
    purchaseOrderNo: row.purchase_order.purchase_order_no,
    erpPurchaseOrderNo: row.purchase_order.erp_purchase_order_no,
    lineNo: row.line_no,
    orderDate: toDateString(row.purchase_order.order_date) as string,
    expectedReceiptDate: toDateString(row.purchase_order.expected_receipt_date),
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    roomQty: Number(roomOf(row)),
    exactMatch: row.ordered_qty.minus(row.received_qty).equals(excessQty),
  };
}
