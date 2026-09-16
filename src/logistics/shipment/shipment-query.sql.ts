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
  hasUnassignedPackedBox?: boolean;
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
/**
 * `hasUnassignedPackedBox` — 「포장이 끝났는데 **아직 어느 출하 단위에도 안 들어간** 상자가
 * 하나라도 있는 출하」(SHIP-UNIT-01 · 장부 P-24).
 *
 * ⭐ `P-04-05` 의 출하 선택 목록이 이 축으로 좁힌다 — 구성할 것이 남은 출하만 보여야 한다.
 * ⛔ 상자의 「포장 끝남」은 `handling_unit.status_code = 'PACKED'` 이고, 그 상자가 «이» 출하의
 *   것이라는 근거는 배분이다(취급 단위 자체는 출하를 모른다).
 * ⚠ 미소속 판정은 링크 표의 부재다 — `handling_unit_id` 가 그 표의 PK 라 한 상자는 한 단위에만
 *   들어간다. 그래서 「없으면 미소속」이 참이다.
 */
export const UNASSIGNED_PACKED_BOX_SQL = `EXISTS (
        SELECT 1
          FROM logistics.shipment_line sl
          JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
          JOIN inventory.handling_unit hu ON hu.handling_unit_id = a.handling_unit_id
         WHERE sl.shipment_id = s.shipment_id
           AND hu.status_code = 'PACKED'
           AND NOT EXISTS (SELECT 1 FROM logistics.shipping_unit_handling_unit link
                            WHERE link.handling_unit_id = hu.handling_unit_id))`;

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

/**
 * 날짜 하나를 «그 출하 공장의» 자정(timestamptz)으로 편다(결정 — 통보 219 ⓔ).
 * ⛔ `shipped_at >= $1::date` 로 두면 DB 가 UTC 라 **UTC 자정**과 견준다 — 하노이(UTC+7)의 00:00~07:00
 *    출하가 «전날»로 간다(CLAUDE.md · `plant.timezone_code`). 공장은 출하 창고에서 푼다.
 * ⛔ 요청 하나를 시간대 하나로 접지 않는다 — `warehouseId` 가 선택이라 한 목록에 공장이 섞인다 ⇒ 행마다 푼다.
 */
function plantMidnightSql(date: string): string {
  return `((${date})::timestamp AT TIME ZONE (SELECT p.timezone_code FROM mdm.warehouse w
                    JOIN mdm.plant p ON p.plant_id = w.plant_id WHERE w.warehouse_id = s.warehouse_id))`;
}

export function whereSql(query: ShipmentFilters): BuiltWhere {
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  // 계약 설명이 「필수」이고 오퍼레이션 설명이 「기간 필수(L-3)」다. ⛔ 400 은 «미선언»이라 통보 219 ⓐ.
  //
  // ⭐ **`hasUnassignedPackedBox` 를 줄 때만 기간이 선택이다**(SHIP-UNIT-01 · 장부 P-24).
  //    그 축은 「구성할 것이 남았나」를 묻는 것이라 **날짜와 무관하다** — 어제 출하한 건의
  //    상자가 오늘 남아 있을 수 있는데, 기간을 강제하면 그 건이 창 밖으로 빠져 `P-04-05`
  //    에서 영영 안 보인다. 기간이 필수인 까닭(전건 스캔 방지)은 그 축이 이미 좁히므로
  //    여기서는 성립하지 않는다.
  const windowOptional = query.hasUnassignedPackedBox === true;
  if (query.shipDateFrom === undefined && !windowOptional) {
    throw one(field('shipDateFrom', ERROR_CODE.REQUIRED, '출하일 시작은 필수입니다.'));
  }
  // ⭐ 기간 축은 `shipped_at` 이다 — 계약이 칸을 안 말했고 날짜 칸 다섯 중 이것만 전건 의미를
  //    갖는다(`created_at` 은 업무 사실이 아니고 `confirmed_at`·`cancelled_at` 은 일부 행만,
  //    `loaded_at` 은 「상차」다). `ShipmentCreate.occurredAt`(「실물이 나간 시각」)이 이 칸에 든다.
  const and = query.shipDateFrom === undefined
    ? []
    : [`s.shipped_at >= ${plantMidnightSql(`${bind(query.shipDateFrom)}::date`)}`];
  if (query.shipDateTo !== undefined) {
    // 경계를 «포함»한다 — 같은 날을 주면 그 날 것이 걸린다. `< to + 1일` 로 적어야 그 날
    // 23:59 도 걸린다(`<= to` 면 자정만 걸려 하루가 통째로 샌다).
    and.push(`s.shipped_at < ${plantMidnightSql(`${bind(query.shipDateTo)}::date + 1`)}`);
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
  // 계약이 한 방향만 적었으므로 `false` 는 절을 «안 건다»(`unconfirmedOnly` 와 같은 관례).
  if (query.hasUnassignedPackedBox === true) and.push(UNASSIGNED_PACKED_BOX_SQL);
  // ⛔ 범위는 `shipment_no` 하나다 — 계약이 「고객은 customerId 를, LOT 은 lotId 를 쓴다」로 닫았다.
  if (query.q !== undefined) and.push(`s.shipment_no ILIKE '%' || ${bind(query.q)} || '%'`);
  if (query.lotId !== undefined) {
    and.push(allocationExists(`a.lot_id = ${bind(query.lotId)}::bigint`));
  }
  // ⛔ 절이 하나도 없을 수 있다 — `hasUnassignedPackedBox` 만 주면 기간 절이 안 선다.
  //    빈 문자열을 돌려주면 호출부의 `WHERE ${sql}` 이 문법 오류가 된다.
  return { sql: and.length === 0 ? 'TRUE' : and.join('\n      AND '), params };
}

/**
 * 기본은 **경과일 긴 순**이다(계약 명시) = 오래된 것이 위 ⇒ 오름차순.
 *
 * ⛔ **`NULLS LAST` 를 «붙이지 않는다».** `shipped_at` 이 nullable 이라 처음엔 붙였는데, 기간이
 * **필수**라 `s.shipped_at >= $1` 이 NULL 행을 **이미 떨어뜨린다**(3값 논리) — 정렬까지 오는
 * NULL 이 **0건**이고 그 절은 **반증할 수 없는 단언**이 된다(README ⭐ 되풀이 병). e2e L-13 이
 * 「NULL 행은 «목록에 없다»」를 대신 못 박는다.
 * ⚠ **그 전제가 한 자리에서 깨졌다**(SHIP-UNIT-01 · 장부 P-24) — `hasUnassignedPackedBox` 를
 *   주면 기간이 선택이라 `shipped_at` 이 NULL 인 행이 정렬까지 온다. 그래도 붙이지 않는다:
 *   PostgreSQL 의 `ASC` 기본이 이미 `NULLS LAST` 라 «아직 안 나간 출하»가 뒤로 간다 —
 *   그것이 원하는 순서다. 명시하면 기본과 같은 말을 두 번 적는 셈이다.
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
