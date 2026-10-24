import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { toDateString } from '../../common/master';
import { OrderSort, readSort } from './purchase-order-list-sort';
import { INBOUND_STAGE_GROUPS, InboundStageGroup } from './inbound-stage';
import { ReceiptStatusCode, dateOnly, lineReceiptStatus, remainingQtyOf } from './purchase-order-receipt';

/**
 * 입하 예정 — 구매발주 «라인» 목록(장부 P-78 · P-85 · #741). 화면은 관리웹 W-01-09 의 오른쪽 표다. 계약 사본에 없는 경로라 질의를 여기서 손으로 검사한다
 * (가드가 보지 않는다). 오류 모양은 가드와 같다 — 400 field `INVALID`.
 */

export interface PurchaseOrderLineListQuery {
  /** 이 P/O 의 라인만(장부 P-85). */
  purchaseOrderId?: bigint;
  expectedReceiptDateFrom?: string;
  expectedReceiptDateTo?: string;
  supplierId?: bigint;
  plantId?: bigint;
  itemId?: bigint;
  q?: string;
  /** 기본 `true` — 남은 수량이 있고 취소되지 않은 라인만. */
  openOnly: boolean;
  /** 납기가 공장 현지 오늘보다 앞인데 남은 라인만. `openOnly` 조건을 함께 건다. */
  overdueOnly: boolean;
  page?: number;
  size?: number;
}

const INT64_MAX = 2n ** 63n - 1n;
const ID_FIELDS = ['purchaseOrderId', 'supplierId', 'plantId', 'itemId'] as const;
const DATE_FIELDS = ['expectedReceiptDateFrom', 'expectedReceiptDateTo'] as const;
const FLAG_FIELDS = ['openOnly', 'overdueOnly'] as const;
const PAGE_FIELDS = ['page', 'size'] as const;

export function parseLineListQuery(raw: Record<string, unknown>): PurchaseOrderLineListQuery {
  const errors: ErrorItem[] = [];
  const parsed: PurchaseOrderLineListQuery = { openOnly: true, overdueOnly: false };

  for (const name of ID_FIELDS) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= INT64_MAX) {
      parsed[name] = BigInt(value);
    } else {
      errors.push(invalid(name, '양의 정수여야 합니다.'));
    }
  }
  for (const name of DATE_FIELDS) {
    const value = readDate(raw, name, errors);
    if (value !== undefined) parsed[name] = value;
  }
  for (const name of FLAG_FIELDS) {
    const value = readFlag(raw, name, errors);
    if (value !== undefined) parsed[name] = value;
  }
  for (const name of PAGE_FIELDS) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value)) parsed[name] = Number(value);
    else errors.push(invalid(name, '1 이상의 정수여야 합니다.'));
  }
  const q = readText(raw, 'q', errors);
  if (q !== undefined) parsed.q = q;

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return parsed;
}

/**
 * 계약 P/O 목록(`GET /logistics/purchase-orders`)에 서버가 먼저 더한 조건(장부 P-85).
 * ⛔ 가드는 계약에 없는 질의를 막지도 형을 바꾸지도 않는다 — 문자열 그대로 오므로 여기서 검사한다.
 */
export interface OrderListExtras {
  expectedReceiptDateFrom?: string;
  expectedReceiptDateTo?: string;
  overdueOnly?: boolean;
  supplierQ?: string;
  /** 그 묶음의 LOT 이 하나라도 있는 발주만(입고 관리 허브의 단계 칩 · 장부 P-110). */
  inboundStage?: InboundStageGroup;
  /** 열 정렬 `sort=열,방향`(장부 P-116). 없으면 발주일 최신순. */
  sort?: OrderSort;
}

export function parseOrderListExtras(raw: Record<string, unknown>): OrderListExtras {
  const errors: ErrorItem[] = [];
  // 키를 늘 싣는다(없으면 undefined) — 컨트롤러가 원래 질의 위에 덮어 문자열 원본이 남지 않게 한다.
  const parsed: OrderListExtras = {
    expectedReceiptDateFrom: readDate(raw, 'expectedReceiptDateFrom', errors),
    expectedReceiptDateTo: readDate(raw, 'expectedReceiptDateTo', errors),
    overdueOnly: readFlag(raw, 'overdueOnly', errors),
    supplierQ: readText(raw, 'supplierQ', errors),
    inboundStage: readStage(raw, errors),
    sort: readSort(raw, errors),
  };

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return parsed;
}

function readDate(raw: Record<string, unknown>, name: string, errors: ErrorItem[]): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value === 'string' && isDate(value)) return value;
  errors.push(invalid(name, 'YYYY-MM-DD 형식입니다.'));
  return undefined;
}

function readFlag(raw: Record<string, unknown>, name: string, errors: ErrorItem[]): boolean | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (value === 'true' || value === 'false') return value === 'true';
  errors.push(invalid(name, 'true 나 false 여야 합니다.'));
  return undefined;
}

function readStage(raw: Record<string, unknown>, errors: ErrorItem[]): InboundStageGroup | undefined {
  const value = raw.inboundStage;
  if (value === undefined) return undefined;
  const stage = INBOUND_STAGE_GROUPS.find((group) => group === value);
  if (stage !== undefined) return stage;
  errors.push(invalid('inboundStage', `${INBOUND_STAGE_GROUPS.join('·')} 중 하나입니다.`));
  return undefined;
}

/** 다듬어 빈 문자열이면 없는 것으로 본다. */
function readText(raw: Record<string, unknown>, name: string, errors: ErrorItem[]): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push(invalid(name, '문자열이어야 합니다.'));
    return undefined;
  }
  return value.trim() === '' ? undefined : value.trim();
}

export const LINE_LIST_INCLUDE = {
  purchase_order: { include: { partner: { select: { partner_code: true, partner_name: true } } } },
  item: { select: { item_code: true, item_name: true } },
  uom: { select: { uom_code: true, uom_name: true } },
} satisfies Prisma.purchase_order_lineInclude;

type LineRow = Prisma.purchase_order_lineGetPayload<{ include: typeof LINE_LIST_INCLUDE }>;

/** 품목·공급사·단위의 코드·이름은 관리웹이 품목마다 따로 부르지 않게 싣는다(장부 P-85). */
export interface PurchaseOrderLineListItem {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  plantId: number;
  orderDate: string;
  /** 납기 — ERP 는 헤더에만 준다(`DLVY_DT`). 라인별 납기 칸은 없다. */
  expectedReceiptDate: string | null;
  purchaseOrderStatusCode: string;
  lineNo: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  uomId: number;
  uomCode: string;
  uomName: string;
  orderedQty: number;
  receivedQty: number;
  /** 발주 − 누적 입하(0 아래는 0). 취소된 라인은 더 들어올 것이 없어 0 이다. */
  remainingQty: number;
  toleranceOverQty: number;
  toleranceUnderQty: number;
  erpStorageLocationCode: string | null;
  cancelledAt: string | null;
  receiptStatusCode: ReceiptStatusCode;
}

/** 값이 없으면 `null` 을 낸다 — 발주 뷰(`purchase-order-view.ts`)와 같은 쪽이다. */
export function lineListItem(row: LineRow): PurchaseOrderLineListItem {
  const order = row.purchase_order;
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(order.purchase_order_id),
    purchaseOrderNo: order.purchase_order_no,
    erpPurchaseOrderNo: order.erp_purchase_order_no,
    supplierId: Number(order.supplier_id),
    supplierCode: order.partner.partner_code,
    supplierName: order.partner.partner_name,
    plantId: Number(order.plant_id),
    orderDate: toDateString(order.order_date) as string,
    expectedReceiptDate: toDateString(order.expected_receipt_date),
    purchaseOrderStatusCode: order.status_code,
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    uomId: Number(row.uom_id),
    uomCode: row.uom.uom_code,
    uomName: row.uom.uom_name,
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    remainingQty: Number(remainingQtyOf(row, order.status_code)),
    toleranceOverQty: Number(row.tolerance_over_qty),
    toleranceUnderQty: Number(row.tolerance_under_qty),
    erpStorageLocationCode: row.erp_storage_location_code,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    receiptStatusCode: lineReceiptStatus(row, order.status_code),
  };
}


/** 형식만이 아니라 실제 있는 날인지도 본다 — `2026-02-30` 은 JS 가 3월 2일로 굴린다. */
function isDate(value: string): boolean {
  const date = dateOnly(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function invalid(name: string, message: string): ErrorItem {
  return field(name, ERROR_CODE.INVALID, message);
}
