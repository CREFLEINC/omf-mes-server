import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { toDateString } from '../../common/master';

/**
 * 계약 `SalesOrder`·`SalesOrderLine` 으로 옮기는 자리.
 *
 * ⛔ 선택 칸(`erpSalesOrderNo`·`lines`·`versionNo`·ERP 원본 칸 셋 · 라인의 `requestedDeliveryDate`·`erpStorageLocationCode`·`cancelledAt`)은
 * `type: ['x','null']` 이 «아니다» — 널을 내리면 ajv 가 깨진다. 값이 없으면 **키를 생략**한다
 * (`omitEmpty`). ⛔ `purchase-order-view.ts`·`goods-issue-view.ts` 는 반대쪽 선례다
 * (거기는 널이 계약을 통과한다) — 보고 따라 하면 안 된다. I-22 §1-4-0.
 */

export type SalesOrderRow = Prisma.sales_orderGetPayload<{
  include: { sales_order_line: true };
}>;
export type SalesOrderLineRow = Prisma.sales_order_lineGetPayload<object>;

export interface SalesOrderLineView {
  salesOrderLineId: number;
  lineNo: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
  requestedDeliveryDate?: string;
  shippedQty: number;
  erpStorageLocationCode?: string;
  cancelledAt?: string;
}

export interface SalesOrderView {
  salesOrderId: number;
  salesOrderNo: string;
  erpSalesOrderNo?: string;
  customerId: number;
  shipToPartnerId: number;
  orderDate: string;
  statusCode: string;
  lines?: SalesOrderLineView[];
  versionNo?: number;
  erpOrderTypeCode?: string;
  erpMovementTypeCode?: string;
  erpSalesGroupCode?: string;
  /** 출하 진행 — 계약 밖 칸(장부 P-132). 취소된 라인은 세지 않는다. */
  shipStatusCode: ShipStatusCode;
  lineCount: number;
  openLineCount: number;
}

/** P/O 입하 진행(`purchase-order-receipt.ts`)과 같은 넷이다 — 출하 수량으로 판정한다. */
export type ShipStatusCode = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';

/**
 * ⭐ 목록도 `lines` 를 싣는다(I-22 R-9) — `W-04-01` §3 ① 이 목록 행에 「3라인」을 그리는데
 * `SalesOrder` 에 라인 수 칸이 0개다. 라인은 롤업이 없어 단순 `include` 로 싸다.
 *
 * ⛔ `statusCode` 는 ERP 수신이 넣은 값을 그대로 내린다 — 이름은 공통코드 `SALES_ORDER_STATUS`
 * 에 있다(장부 P-72 · 계약은 `x-no-code-key`). 상수를 만들지 않는다.
 */
export function salesOrderView(row: SalesOrderRow): SalesOrderView {
  return omitEmpty({
    salesOrderId: Number(row.sales_order_id),
    salesOrderNo: row.sales_order_no,
    erpSalesOrderNo: row.erp_sales_order_no ?? undefined,
    customerId: Number(row.customer_id),
    shipToPartnerId: Number(row.ship_to_partner_id),
    orderDate: toDateString(row.order_date) as string,
    statusCode: row.status_code,
    lines: row.sales_order_line.map(salesOrderLineView),
    versionNo: row.version_no,
    erpOrderTypeCode: row.erp_order_type_code ?? undefined,
    erpMovementTypeCode: row.erp_movement_type_code ?? undefined,
    erpSalesGroupCode: row.erp_sales_group_code ?? undefined,
    ...shipProgress(row),
  });
}

function shipProgress(row: SalesOrderRow): Pick<SalesOrderView, 'shipStatusCode' | 'lineCount' | 'openLineCount'> {
  const live = row.sales_order_line.filter((line) => line.cancelled_at === null);
  const unshipped = live.filter((line) => line.shipped_qty.lessThan(line.ordered_qty)).length;
  const shipStatusCode = shipStatus(row.status_code, live, unshipped);
  // 취소된 수주는 남은 라인이 있어도 출하할 것이 없다 — `progress=OPEN` 에 안 걸리는 것과 맞춘다.
  return { shipStatusCode, lineCount: live.length, openLineCount: shipStatusCode === 'CANCELLED' ? 0 : unshipped };
}

function shipStatus(statusCode: string, live: SalesOrderLineRow[], openLineCount: number): ShipStatusCode {
  if (statusCode === 'CANCELLED' || live.length === 0) return 'CANCELLED';
  if (openLineCount === 0) return 'COMPLETED';
  return live.some((line) => line.shipped_qty.greaterThan(0)) ? 'PARTIAL' : 'NOT_STARTED';
}

/** `shipped_qty` 는 `DEFAULT 0` 이라 생략된 적이 없다 — Decimal 0 을 그대로 낸다(널 아님). */
export function salesOrderLineView(row: SalesOrderLineRow): SalesOrderLineView {
  return omitEmpty({
    salesOrderLineId: Number(row.sales_order_line_id),
    lineNo: row.line_no,
    itemId: Number(row.item_id),
    orderedQty: Number(row.ordered_qty),
    uomId: Number(row.uom_id),
    requestedDeliveryDate: toDateString(row.requested_delivery_date) ?? undefined,
    shippedQty: Number(row.shipped_qty),
    erpStorageLocationCode: row.erp_storage_location_code ?? undefined,
    cancelledAt: row.cancelled_at?.toISOString(),
  });
}
