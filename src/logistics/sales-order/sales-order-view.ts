import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { toDateString } from '../../common/master';

/**
 * 계약 `SalesOrder`·`SalesOrderLine` 으로 옮기는 자리.
 *
 * ⛔ 선택 칸 넷(`erpSalesOrderNo`·`lines`·`versionNo`·`SalesOrderLine.requestedDeliveryDate`)은
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
  /** ERP 출고창고(SL_CD)·ERP 가 이 라인을 취소한 시각 — 계약 밖 칸(장부 P-75). */
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
  /** ERP 수주유형(SO_TYPE_CD)·수불유형(MOV_TYPE)·영업그룹(SALES_GRP_CD) — 계약 밖 칸(장부 P-75). */
  erpOrderTypeCode?: string;
  erpMovementTypeCode?: string;
  erpSalesGroupCode?: string;
}

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
  });
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
