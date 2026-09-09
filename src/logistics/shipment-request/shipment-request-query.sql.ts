import { ERROR_CODE, field, one } from '../../common/errors';
import {
  SHIPMENT_PROGRESS_CASE_SQL,
  SHIPMENT_PROGRESS_TOTALS_SQL,
  shipmentLinePickedSql,
} from './shipment-progress';

/**
 * `GET /logistics/shipment-requests`(14축) · `…/summary`(11축)의 SQL 조립. 갈라 둔 이유는
 * **정렬 2차 키와 「이 축은 «안» 건다」가 HTTP e2e 로 «구조적으로» 반증되지 않는다**는 것이다
 * (README §6-3 ⑹) — `*-query.spec.ts` 가 여기 두 함수만 직접 겨눈다.
 */

/** 요약이 받는 **11축**. 목록은 여기에 `sort`·`page`·`size` 를 더해 14축이다(계약 명시). */
export interface ShipmentRequestFilters {
  customerId?: number;
  shipToPartnerId?: number;
  itemId?: number;
  /**
   * ⛔ 받고 «버린다» — 계약이 「이 축으로는 거를 수 없다(「칸 불필요」로 닫힌 칸)」라 적었다.
   * 파라미터를 지우지 않았으므로 400 도 내지 않는다(e2e L-36 · 단위 「절을 만들지 않는다」).
   */
  statusCode?: string;
  shipmentProgressCode?: string;
  timeSlotCode?: string;
  shippingInspectionRequired?: boolean;
  shipDateFrom?: string;
  shipDateTo?: string;
  pickingCompleteOnly?: boolean;
  shippableRemainderOnly?: boolean;
}

export interface ShipmentRequestQuery extends ShipmentRequestFilters {
  sort?: string;
  page?: number;
  size?: number;
}

export interface BuiltWhere {
  sql: string;
  params: unknown[];
}

/**
 * ⭐ 바깥 별칭은 `sr` · LATERAL 안쪽은 `t` 다 — ③a 의 두 상수가 각각 `sr.shipment_request_id` 로
 * 상관되고 `t.picked_qty` 를 읽는다. ⛔ 별칭을 바꾸면 Postgres `42703` 으로 **500** 이다.
 * ⚠ 안쪽이 집계라 라인 0건이어도 «한 행»을 낸다 — `ON TRUE` 가 헤더를 안 떨어뜨린다.
 */
export const FROM_SQL = `logistics.shipment_request sr
    JOIN LATERAL (${SHIPMENT_PROGRESS_TOTALS_SQL}) t ON TRUE`;

/**
 * `pickingCompleteOnly` — 「라인 «전체»가 `pickedQty = allocatedQty`」. ⭐ **라인 축이라 헤더
 * 4합계로 도출할 수 없다** — 라인1 `P=10/A=5` · 라인2 `P=0/A=5` 면 헤더는 `P=A` 인데 답은 거짓이다.
 * ⛔ 앞 절(`EXISTS(라인)`)을 빼지 마라 — 라인 0건이 `NOT EXISTS` 만으로는 **공허참**이다(e2e L-9).
 * ⭐ `incompletePickingCount` 가 이 상수를 `NOT (…)` 로 뒤집는다 — 복제하면 둘이 갈린다.
 */
export const PICKING_COMPLETE_SQL = `(EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id)
        AND NOT EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id
                      AND ${shipmentLinePickedSql('l')} < l.allocated_qty))`;

/** `shippableRemainderOnly` — 「`shippedQty < allocatedQty` 인 라인이 «하나라도»」. 정량자가 위와 반대다. */
export const SHIPPABLE_REMAINDER_SQL = `EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id
                      AND l.shipped_qty < l.allocated_qty)`;

/**
 * ⭐ **`pendingInspectionCount` 전용 «무손실» 좁히기.** 검사 필수 라인이 0개면 라인 값이 전부
 * `NOT_REQUIRED` 이고(라인 0건도 그렇다) 헤더 롤업 우선순위가 `PENDING` 을 **낼 수 없다** ⇒ 이
 * 술어로 걸러도 그 건수는 한 건도 안 변한다(e2e L-48 이 무손실을 직접 확인한다).
 * ⛔ 목록·요약의 다른 칸에는 쓰지 마라 — 저 롤업 한 칸에서만 무손실이다.
 */
export const INSPECTION_REQUIRED_SQL = `EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id
                      AND l.shipping_inspection_required)`;

/** 계약이 「출하일·고객·작업지시번호 셋만」이라 못박았다 — 그 밖은 400 `INVALID`(e2e L-39). */
const SORT_COLUMNS: Record<string, string> = {
  requestedShipDate: 'sr.requested_ship_date',
  customerId: 'sr.customer_id',
  shipmentRequestNo: 'sr.shipment_request_no',
};

/** ⭐ `EXISTS` 다 — 조인이면 라인 수만큼 헤더가 중복되고 `page.total` 이 부푼다(e2e L-6·L-7). */
function lineExists(condition: string): string {
  return `EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id AND ${condition})`;
}

/**
 * 목록·요약이 **같은 함수**로 `WHERE` 를 만든다 — 복붙하면 요약 카드와 목록이 다른 것을 센다
 * (e2e L-45). `@db.Date` 라 타임존을 붙이지 않고 날짜끼리 비교한다(CLAUDE.md).
 */
export function whereSql(query: ShipmentRequestFilters): BuiltWhere {
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  // ⭐ 요약에도 **같은** 게이트다 — 계약이 「필수 · 목록과 같은 기준을 쓴다」라 적었다(L-2·L-2b).
  if (query.shipDateFrom === undefined) {
    throw one(field('shipDateFrom', ERROR_CODE.REQUIRED, '출하 희망일 시작은 필수입니다.'));
  }
  // 경계를 «포함»한다 — 같은 날을 주면 그 날 것이 걸린다(L-3·L-4).
  const and = [`sr.requested_ship_date >= ${bind(query.shipDateFrom)}::date`];
  if (query.shipDateTo !== undefined) {
    and.push(`sr.requested_ship_date <= ${bind(query.shipDateTo)}::date`);
  }
  if (query.customerId !== undefined) and.push(`sr.customer_id = ${bind(query.customerId)}::bigint`);
  if (query.shipToPartnerId !== undefined) {
    and.push(`sr.ship_to_partner_id = ${bind(query.shipToPartnerId)}::bigint`);
  }
  // ⛔ 시간대가 NULL 인 행은 안 걸린다 — `IS NULL` 을 함께 집으면 필터가 뜻을 잃는다(L-8).
  if (query.timeSlotCode !== undefined) {
    and.push(`sr.ship_time_slot_code = ${bind(query.timeSlotCode)}`);
  }
  if (query.itemId !== undefined) and.push(lineExists(`l.item_id = ${bind(query.itemId)}::bigint`));
  if (query.shippingInspectionRequired !== undefined) {
    and.push(lineExists(`l.shipping_inspection_required = ${bind(query.shippingInspectionRequired)}`));
  }
  // ⛔ 여기서 `CASE` 를 다시 적지 마라 — 응답 칸은 TS 판정이라 그 순간 두 벌이 갈린다(§5-1).
  if (query.shipmentProgressCode !== undefined) {
    and.push(`${SHIPMENT_PROGRESS_CASE_SQL} = ${bind(query.shipmentProgressCode)}`);
  }
  // 계약이 한 방향만 적었다 — `false` 는 필터를 «안 건다»(선례 `unassignedOnly`).
  if (query.pickingCompleteOnly === true) and.push(PICKING_COMPLETE_SQL);
  if (query.shippableRemainderOnly === true) and.push(SHIPPABLE_REMAINDER_SQL);
  return { sql: and.join('\n      AND '), params };
}

/**
 * 기본은 **임박한 것이 위**다(계약 침묵 · `W-04-02` 가 출하일 순으로 읽는다). ⛔ 2차 키를 빼지
 * 마라 — 동률 순서는 SQL 표준이 «미정의»라 쪽 경계에서 행이 겹치거나 샌다. 그 부재는 HTTP 로
 * 반증되지 않아(§6-3 ⑹) `*-query.spec.ts` 가 이 문자열을 **통째로** 대조한다.
 */
export function orderBySql(sort: string | undefined): string {
  const key = sort ?? 'requestedShipDate';
  if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, key)) {
    throw one(
      field('sort', ERROR_CODE.INVALID, `정렬은 ${Object.keys(SORT_COLUMNS).join(' · ')} 셋뿐입니다.`),
    );
  }
  return `${SORT_COLUMNS[key]} ASC, sr.shipment_request_id ASC`;
}
