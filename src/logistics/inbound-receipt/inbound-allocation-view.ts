import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { toDateString } from '../../common/master';
import { roomOf, unallocatedQtyOf } from './inbound-allocation';

/**
 * 입하 배정 경로의 질의·본문 검사와 응답 모양. 계약 사본에 없는 경로라 가드가 보지 않는다 — 여기서 손으로 검사하고
 * 오류 모양은 가드와 같게 한다(초과분 경로 P-100 과 같은 길).
 */

export interface UnallocatedQuery {
  plantId?: bigint;
  supplierId?: bigint;
  itemId?: bigint;
  page?: number;
  size?: number;
}

const INT64_MAX = 2n ** 63n - 1n;
const ID_FIELDS = ['plantId', 'supplierId', 'itemId'] as const;
const PAGE_FIELDS = ['page', 'size'] as const;

export function parseUnallocatedQuery(raw: Record<string, unknown>): UnallocatedQuery {
  const errors: ErrorItem[] = [];
  const parsed: UnallocatedQuery = {};
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
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return parsed;
}

/** 경로의 id — 틀리면 400 field `INVALID`. */
export function parsePathId(name: string, raw: string): bigint {
  const value = readId(raw);
  if (value === undefined) throw new ContractException(HttpStatus.BAD_REQUEST, [invalid(name, '양의 정수여야 합니다.')]);
  return value;
}

/** 배정 추가 본문 — `{ purchaseOrderLineId, qty }`. JSON 숫자로 온다. 0 이하·한도 검사는 서비스가 한다. */
export function parseAllocationBody(body: unknown): { purchaseOrderLineId: bigint; qty: Prisma.Decimal } {
  const errors: ErrorItem[] = [];
  const raw = (body ?? {}) as { purchaseOrderLineId?: unknown; qty?: unknown };
  const lineId = raw.purchaseOrderLineId;
  const lineOk = typeof lineId === 'number' && Number.isSafeInteger(lineId) && lineId > 0;
  if (!lineOk) errors.push(field('purchaseOrderLineId', lineId === undefined ? ERROR_CODE.REQUIRED : ERROR_CODE.INVALID, '양의 정수여야 합니다.'));
  const qtyOk = typeof raw.qty === 'number' && Number.isFinite(raw.qty);
  if (!qtyOk) errors.push(field('qty', raw.qty === undefined ? ERROR_CODE.REQUIRED : ERROR_CODE.INVALID, '수여야 합니다.'));
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return { purchaseOrderLineId: BigInt(lineId as number), qty: new Prisma.Decimal(raw.qty as number) };
}

function readId(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) return undefined;
  const id = BigInt(value);
  return id <= INT64_MAX ? id : undefined;
}

function invalid(name: string, message: string): ErrorItem {
  return field(name, ERROR_CODE.INVALID, message);
}

// ---- 응답 모양 ----

const ORDER_LINE_INCLUDE = {
  purchase_order: { select: { purchase_order_id: true, purchase_order_no: true, erp_purchase_order_no: true } },
} satisfies Prisma.purchase_order_lineInclude;
type OrderLineRow = Prisma.purchase_order_lineGetPayload<{ include: typeof ORDER_LINE_INCLUDE }>;

export interface OrderLineRef {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  lineNo: number;
}

export const ALLOCATION_INCLUDE = {
  purchase_order_line: { include: ORDER_LINE_INCLUDE },
} satisfies Prisma.inbound_receipt_po_allocationInclude;
export type AllocationRow = Prisma.inbound_receipt_po_allocationGetPayload<{ include: typeof ALLOCATION_INCLUDE }>;

/** 배정 한 몫 — 어느 P/O 라인에 얼마를, 언제. */
export interface InboundAllocationView {
  inboundReceiptPoAllocationId: number;
  inboundReceiptLineId: number;
  allocatedQty: number;
  allocatedAt: string;
  orderLine: OrderLineRef;
}

export function allocationView(row: AllocationRow): InboundAllocationView {
  return {
    inboundReceiptPoAllocationId: Number(row.inbound_receipt_po_allocation_id),
    inboundReceiptLineId: Number(row.inbound_receipt_line_id),
    allocatedQty: Number(row.allocated_qty),
    allocatedAt: row.created_at.toISOString(),
    orderLine: orderLineRef(row.purchase_order_line),
  };
}

export const UNALLOCATED_LINE_INCLUDE = {
  inbound_receipt: { include: { partner: { select: { partner_code: true, partner_name: true } } } },
  item: { select: { item_code: true, item_name: true } },
  uom: { select: { uom_code: true } },
  lot: { select: { lot_no: true } },
  inbound_receipt_po_allocation: { include: ALLOCATION_INCLUDE, orderBy: { inbound_receipt_po_allocation_id: 'asc' } },
} satisfies Prisma.inbound_receipt_lineInclude;
export type UnallocatedLineRow = Prisma.inbound_receipt_lineGetPayload<{ include: typeof UNALLOCATED_LINE_INCLUDE }>;

/** 미배정이 남은 입하 줄 — 무엇이 얼마나 남았고 어디에 얼마나 배정됐나. */
export interface UnallocatedLineView {
  inboundReceiptLineId: number;
  lineNo: number;
  inboundReceiptId: number;
  inboundReceiptNo: string;
  receiptDatetime: string;
  /** 무발주 입하(예외 유형)면 그 유형 — 고객사급처럼 P/O 와 이을 일이 없는 줄을 화면이 가린다. */
  exceptionTypeCode: string | null;
  /** 줄 전체 수량 — LOT 의 처음 수량이다. */
  receivedQty: number;
  unallocatedQty: number;
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
  allocations: InboundAllocationView[];
}

export function unallocatedLineView(row: UnallocatedLineRow): UnallocatedLineView {
  const receipt = row.inbound_receipt;
  return {
    inboundReceiptLineId: Number(row.inbound_receipt_line_id),
    lineNo: row.line_no,
    inboundReceiptId: Number(receipt.inbound_receipt_id),
    inboundReceiptNo: receipt.inbound_receipt_no,
    receiptDatetime: receipt.receipt_datetime.toISOString(),
    exceptionTypeCode: receipt.exception_type_code,
    receivedQty: Number(row.received_qty),
    unallocatedQty: unallocatedQtyOf(row.received_qty, row.inbound_receipt_po_allocation).toNumber(),
    plantId: Number(receipt.plant_id),
    supplierId: Number(receipt.supplier_id),
    supplierCode: receipt.partner.partner_code,
    supplierName: receipt.partner.partner_name,
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    uomId: Number(row.uom_id),
    uomCode: row.uom.uom_code,
    lotId: row.lot_id === null ? null : Number(row.lot_id),
    lotNo: row.lot?.lot_no ?? null,
    allocations: row.inbound_receipt_po_allocation.map(allocationView),
  };
}

export type CandidateRow = Prisma.purchase_order_lineGetPayload<{ include: { purchase_order: true } }>;

/** 배정할 수 있는 P/O 라인 후보. 남은 수량이 미배정 수량과 같으면 `exactMatch` 다. */
export interface AllocationCandidateView extends OrderLineRef {
  orderDate: string;
  expectedReceiptDate: string | null;
  orderedQty: number;
  receivedQty: number;
  roomQty: number;
  exactMatch: boolean;
}

export function candidateView(row: CandidateRow, qty: Prisma.Decimal): AllocationCandidateView {
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
    exactMatch: row.ordered_qty.minus(row.received_qty).equals(qty),
  };
}

function orderLineRef(row: OrderLineRow): OrderLineRef {
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(row.purchase_order.purchase_order_id),
    purchaseOrderNo: row.purchase_order.purchase_order_no,
    erpPurchaseOrderNo: row.purchase_order.erp_purchase_order_no,
    lineNo: row.line_no,
  };
}
