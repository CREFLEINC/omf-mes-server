import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';

/**
 * 입하 예정 — 구매발주 «라인» 목록(장부 P-78 · #741). 질의 검증은 계약 검증 가드가 한다
 * (`GET /logistics/purchase-order-lines`) — 여기는 검증을 지난 값을 서비스 형으로 옮기기만 한다.
 */

/** 발주가 끝난 헤더 상태 — 발주 목록 `openOnly` 와 같은 둘이다(`purchase-order-query.service.ts`). */
export const CLOSED_ORDER_STATUSES = ['CLOSED', 'CANCELLED'];

/** 계약 검증 가드를 지난 질의 — 정수·불리언은 가드가 이미 형을 바꿔 둔다. */
export interface PurchaseOrderLineListRawQuery {
  expectedReceiptDateFrom?: string;
  expectedReceiptDateTo?: string;
  supplierId?: number;
  plantId?: number;
  itemId?: number;
  q?: string;
  openOnly?: boolean;
  overdueOnly?: boolean;
  page?: number;
  size?: number;
}

export interface PurchaseOrderLineListQuery {
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

export function lineListQuery(raw: PurchaseOrderLineListRawQuery): PurchaseOrderLineListQuery {
  const q = raw.q?.trim();
  return {
    ...(raw.supplierId === undefined ? {} : { supplierId: BigInt(raw.supplierId) }),
    ...(raw.plantId === undefined ? {} : { plantId: BigInt(raw.plantId) }),
    ...(raw.itemId === undefined ? {} : { itemId: BigInt(raw.itemId) }),
    ...(raw.expectedReceiptDateFrom === undefined ? {} : { expectedReceiptDateFrom: raw.expectedReceiptDateFrom }),
    ...(raw.expectedReceiptDateTo === undefined ? {} : { expectedReceiptDateTo: raw.expectedReceiptDateTo }),
    ...(q ? { q } : {}),
    openOnly: raw.openOnly ?? true,
    overdueOnly: raw.overdueOnly ?? false,
    ...(raw.page === undefined ? {} : { page: raw.page }),
    ...(raw.size === undefined ? {} : { size: raw.size }),
  };
}

/**
 * 라인의 입하 진행 — 서버가 판정해 화면이 규칙을 복사하지 않게 한다.
 * 「다 들어왔다」는 받은 수량이 발주 수량에 닿았을 때다. 부족 허용치(`tolerance_under_qty`)는 빼지 않는다 —
 * 발주 목록 `openOnly` 와 같은 기준이다(I-2.md §6-4). 이름은 저장소의 진행 어휘(처분 진행 `DispositionProgressCode`)를 따른다.
 */
export type ReceiptStatusCode = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';

type LineRow = Prisma.purchase_order_lineGetPayload<{ include: { purchase_order: true } }>;

export function receiptStatusOf(row: LineRow): ReceiptStatusCode {
  // 헤더 취소는 MES 취소 · ERP 가 라인을 모두 취소한 경우다 — 어느 쪽이든 더 들어올 것이 없다.
  if (row.cancelled_at !== null || row.purchase_order.status_code === 'CANCELLED') return 'CANCELLED';
  if (row.received_qty.greaterThanOrEqualTo(row.ordered_qty)) return 'COMPLETED';
  return row.received_qty.greaterThan(0) ? 'PARTIAL' : 'NOT_STARTED';
}

export interface PurchaseOrderLineListItem {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  plantId: number;
  orderDate: string;
  /** 납기 — ERP 는 헤더에만 준다(`DLVY_DT`). 라인별 납기 칸은 없다. */
  expectedReceiptDate: string | null;
  purchaseOrderStatusCode: string;
  lineNo: number;
  itemId: number;
  uomId: number;
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
  const status = receiptStatusOf(row);
  const remaining = row.ordered_qty.minus(row.received_qty);
  return {
    purchaseOrderLineId: Number(row.purchase_order_line_id),
    purchaseOrderId: Number(order.purchase_order_id),
    purchaseOrderNo: order.purchase_order_no,
    erpPurchaseOrderNo: order.erp_purchase_order_no,
    supplierId: Number(order.supplier_id),
    plantId: Number(order.plant_id),
    orderDate: toDateString(order.order_date) as string,
    expectedReceiptDate: toDateString(order.expected_receipt_date),
    purchaseOrderStatusCode: order.status_code,
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    uomId: Number(row.uom_id),
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    remainingQty: status === 'CANCELLED' || remaining.lessThan(0) ? 0 : Number(remaining),
    toleranceOverQty: Number(row.tolerance_over_qty),
    toleranceUnderQty: Number(row.tolerance_under_qty),
    erpStorageLocationCode: row.erp_storage_location_code,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    receiptStatusCode: status,
  };
}

/** `expected_receipt_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md). */
export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
