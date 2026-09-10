import { ERROR_CODE, field, one } from '../../common/errors';
import { shipmentLinePickedSql } from '../shipment-request/shipment-progress';

/**
 * `GET /logistics/shipments`(13축)의 SQL 조립. 갈라 둔 이유는 **정렬 2차 키와 「이 축은 «안» 건다」가
 * HTTP e2e 로 «구조적으로» 반증되지 않는다**는 것이다(README §6-3 ⑹) — `shipment-query.spec.ts` 가
 * 여기 두 함수를 직접 겨눈다.
 */

export interface ShipmentFilters {
  shipmentRequestId?: number;
  customerId?: number;
  statusCode?: string;
  warehouseId?: number;
  pickedOnly?: boolean;
  unconfirmedOnly?: boolean;
  shipDateFrom?: string;
  shipDateTo?: string;
  q?: string;
  lotId?: number;
}

export interface ShipmentQuery extends ShipmentFilters {
  sort?: string;
  page?: number;
  size?: number;
}

export interface BuiltWhere {
  sql: string;
  params: unknown[];
}

const UNCONFIRMED = 'UNCONFIRMED';

/** 바깥 별칭은 `s` 다 — 아래 상수들이 `s.shipment_id` 로 상관된다. */
export const FROM_SQL = 'logistics.shipment s';

/**
 * `pickedOnly` — 「그 출하가 가리키는 출하작업지시의 라인 «전체»가 `pickedQty = allocatedQty`」.
 *
 * ⭐ **I-22 의 `shipmentLinePickedSql()` 을 `import` 해서 쓴다** — 예약 합계를 여기서 다시 적으면
 * 「목록이 거른 것」과 「피킹 화면이 보는 것」이 경계 하나에서 갈린다(I-22 §11 ①).
 * ⛔ 「출하가 섰으니 피킹은 늘 끝났다」로 접지 않는다 — 부분 출하가 본길이라 그것은 **조용히
 * 전건을 내리는 것**이다(§2 2단계 기준 4).
 * ⛔ 앞 절(`EXISTS(라인)`)을 빼지 마라 — 라인 0건이 `NOT EXISTS` 만으로는 **공허참**이다.
 */
export const PICKED_ONLY_SQL = `(EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = s.shipment_request_id)
        AND NOT EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = s.shipment_request_id
                      AND ${shipmentLinePickedSql('l')} < l.allocated_qty))`;

/**
 * 계약이 정렬 키 «목록»을 안 줬다 — 「경과일 긴 순이 기본이다」 한 문장뿐이다.
 * ⇒ 둘로 닫고 그 밖은 400 `INVALID`(§2 2단계 기준 2 — 거부하는 쪽).
 * ⛔ `customerId` 를 넣지 않는다 — `shipment` 의 칸이 «아니라» `shipment_request` 조인이라
 * 정렬 축으로 열면 바깥 질의가 조인을 끌고 와야 한다(통보 219 ⓒ).
 */
const SORT_COLUMNS: Record<string, string> = {
  shippedAt: 's.shipped_at',
  shipmentNo: 's.shipment_no',
};

/**
 * ⭐ `EXISTS` 다 — 조인이면 라인·배분 수만큼 헤더가 중복되고 `page.total` 이 부푼다.
 */
function allocationExists(condition: string): string {
  return `EXISTS (SELECT 1 FROM logistics.shipment_line sl
                    JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
                   WHERE sl.shipment_id = s.shipment_id AND ${condition})`;
}

export function whereSql(query: ShipmentFilters): BuiltWhere {
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  // 계약 설명이 「필수」이고 오퍼레이션 설명이 「기간 필수(L-3)」다. ⛔ 400 은 «미선언»이라 통보 219 ⓐ.
  if (query.shipDateFrom === undefined) {
    throw one(field('shipDateFrom', ERROR_CODE.REQUIRED, '출하일 시작은 필수입니다.'));
  }
  // ⭐ 기간 축은 `shipped_at` 이다 — 계약이 칸을 안 말했고 날짜 칸 다섯 중 이것만 전건 의미를
  //    갖는다(`created_at` 은 업무 사실이 아니고 `confirmed_at`·`cancelled_at` 은 일부 행만,
  //    `loaded_at` 은 「상차」다). `ShipmentCreate.occurredAt`(「실물이 나간 시각」)이 이 칸에 든다.
  // ⛔ timestamptz 를 날짜로 접을 때 타임존을 붙이지 않는다 — 하노이 경계가 어긋난다(CLAUDE.md).
  //    공장 로컬이 필요해지면 `plant.timezone_code` 로 푼다(통보 219 ⓔ).
  const and = [`s.shipped_at >= ${bind(query.shipDateFrom)}::date`];
  if (query.shipDateTo !== undefined) {
    // 경계를 «포함»한다 — 같은 날을 주면 그 날 것이 걸린다. `< to + 1일` 로 적어야 그 날
    // 23:59 도 걸린다(`<= to::date` 면 자정만 걸려 하루가 통째로 샌다).
    and.push(`s.shipped_at < ${bind(query.shipDateTo)}::date + interval '1 day'`);
  }
  if (query.shipmentRequestId !== undefined) {
    and.push(`s.shipment_request_id = ${bind(query.shipmentRequestId)}::bigint`);
  }
  // ⛔ `shipment` 에 고객 칸이 «없다» — 출하작업지시를 타고 간다(§1-2).
  if (query.customerId !== undefined) {
    and.push(`EXISTS (SELECT 1 FROM logistics.shipment_request r
                   WHERE r.shipment_request_id = s.shipment_request_id
                     AND r.customer_id = ${bind(query.customerId)}::bigint)`);
  }
  if (query.statusCode !== undefined) and.push(`s.status_code = ${bind(query.statusCode)}`);
  if (query.warehouseId !== undefined) {
    and.push(`s.warehouse_id = ${bind(query.warehouseId)}::bigint`);
  }
  // ⭐ `statusCode` 와 **AND** 로 겹친다 — 둘이 오면 교집합이다(`statusCode=CONFIRMED` +
  //    `unconfirmedOnly=true` 는 0건이 «정답»이다. 한쪽을 이기게 만들면 화면이 못 믿는다).
  //    계약이 한 방향만 적었으므로 `false` 는 절을 «안 건다»(선례 `unassignedOnly`).
  if (query.unconfirmedOnly === true) and.push(`s.status_code = '${UNCONFIRMED}'`);
  if (query.pickedOnly === true) and.push(PICKED_ONLY_SQL);
  // ⛔ 범위는 `shipment_no` 하나다 — 계약이 「고객은 customerId 를, LOT 은 lotId 를 쓴다」로 닫았다.
  if (query.q !== undefined) and.push(`s.shipment_no ILIKE '%' || ${bind(query.q)} || '%'`);
  if (query.lotId !== undefined) {
    and.push(allocationExists(`a.lot_id = ${bind(query.lotId)}::bigint`));
  }
  return { sql: and.join('\n      AND '), params };
}

/**
 * 기본은 **경과일 긴 순**이다(계약 명시) = 오래된 것이 위 ⇒ 오름차순.
 *
 * ⛔ **`NULLS LAST` 를 «붙이지 않는다».** `shipped_at` 이 nullable 이라 처음엔 붙였는데, 기간이
 * **필수**라 `s.shipped_at >= $1` 이 NULL 행을 **이미 떨어뜨린다**(3값 논리) — 정렬까지 오는
 * NULL 이 **0건**이고 그 절은 **반증할 수 없는 단언**이 된다(README ⭐ 되풀이 병). e2e L-13 이
 * 「NULL 행은 «목록에 없다»」를 대신 못 박는다.
 * ⛔ 2차 키를 빼지 마라 — 동률 순서는 SQL 표준이 «미정의»라 쪽 경계에서 행이 겹치거나 샌다.
 * 그 부재는 HTTP 로 반증되지 않아(§6-3 ⑹) `shipment-query.spec.ts` 가 이 문자열을 통째로 대조한다.
 */
export function orderBySql(sort: string | undefined): string {
  const key = sort ?? 'shippedAt';
  if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, key)) {
    throw one(
      field('sort', ERROR_CODE.INVALID, `정렬은 ${Object.keys(SORT_COLUMNS).join(' · ')} 둘뿐입니다.`),
    );
  }
  return `${SORT_COLUMNS[key]} ASC, s.shipment_id ASC`;
}
