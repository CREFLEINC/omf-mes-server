import { Prisma } from '@prisma/client';

/**
 * 출하 진행 6값 — 계약 `ShipmentRequest.shipmentProgressCode`. **TS 판정과 SQL 술어를 한 파일에
 * 나란히 둔다**(I-22 §5-1 · 통합 M-4). ⭐ 두 벌이 필요하다 — 응답 칸은 TS 로 내지만
 * `?shipmentProgressCode=` 필터와 `summary` 의 건수는 **페이지네이션 «전»**이라 이 함수를 못 부르고
 * 같은 판정을 SQL 로 다시 적는다(0단계 선례 `disposition-rollup.ts:20-23`). 문자열이 갈리면
 * 「목록이 거른 것」과 「행이 보이는 값」이 어긋난다(I-20 R-2 형) ⇒ spec 의 「TS 판정과 SQL 술어가
 * 같은 6값 경계를 쓴다」가 **CASE 를 평가해 두 벌을 대조**한다. ⛔ 한쪽만 고치지 마라.
 * ⛔ 부동소수로 세지 않는다 — 넷 다 `numeric(20,6)` 이라 `0.1 + 0.2` 가 새면 경계가 흔들린다.
 */

// prettier-ignore
export type ShipmentProgressCode =
  | 'NOT_ALLOCATED' | 'PARTIALLY_ALLOCATED' | 'PICKING' | 'PICKED' | 'PARTIALLY_SHIPPED' | 'SHIPPED';

/** I-22 `:pick`(PR ⑥)이 거는 예약의 `source_document_type_code` — 여기가 그 값의 유일한 자리다. */
export const SHIPMENT_REQUEST_LINE = 'SHIPMENT_REQUEST_LINE';

const ZERO = new Prisma.Decimal(0);

/** 라인 하나에 매달린 예약 한 줄. `P` 는 **Σ(reserved − released)** 다(R-14). */
export interface ShipmentProgressReservation {
  reservedQty: Prisma.Decimal;
  releasedQty: Prisma.Decimal;
}

export interface ShipmentProgressLine {
  requestedQty: Prisma.Decimal;
  allocatedQty: Prisma.Decimal;
  shippedQty: Prisma.Decimal;
  reservations: ShipmentProgressReservation[];
}

/** `R`·`A`·`P`·`S` — 한 작업지시의 라인 전체 합. */
export interface ShipmentProgressTotals {
  requestedQty: Prisma.Decimal;
  allocatedQty: Prisma.Decimal;
  pickedQty: Prisma.Decimal;
  shippedQty: Prisma.Decimal;
}

/**
 * ⭐ `released_qty` 를 **뺀다**(R-14 · §5-1 정본). 안 빼면 예약을 푼 뒤에도 `P` 가 그대로 남아
 * `PICKED` 로 잘못 오르고, 그 값이 `W-04-04` 의 진입 목록을 정한다.
 * ⚠ **I-23 이 취소 시 `released_qty` 를 올려야 이 뺄셈이 산다** — 오늘 코어의 `pick()` Δ<0 갈래는
 *   `consumed_qty` 만 내리고, 저장소에 `released_qty` 를 «쓰는» 코드가 0개다. ⛔ 그렇다고
 *   `- consumed_qty` 를 더하지 마라 — 피킹 직후 `P = 0` 이 되어 `PICKED` 가 영영 안 나온다.
 */
export function pickedQtyOf(reservations: ShipmentProgressReservation[]): Prisma.Decimal {
  return reservations.reduce((sum, row) => sum.plus(row.reservedQty).minus(row.releasedQty), ZERO);
}

export function shipmentProgressTotals(lines: ShipmentProgressLine[]): ShipmentProgressTotals {
  return lines.reduce<ShipmentProgressTotals>(
    (totals, line) => ({
      requestedQty: totals.requestedQty.plus(line.requestedQty),
      allocatedQty: totals.allocatedQty.plus(line.allocatedQty),
      pickedQty: totals.pickedQty.plus(pickedQtyOf(line.reservations)),
      shippedQty: totals.shippedQty.plus(line.shippedQty),
    }),
    { requestedQty: ZERO, allocatedQty: ZERO, pickedQty: ZERO, shippedQty: ZERO },
  );
}

/**
 * 계약이 「판정 순서는 **뒤가 이긴다**」라 적었다. ⛔⛔ `A = 0` **하나만** 그 규약의 예외다 —
 * 그때 `PICKED`(`P=A ∧ S=0`)와 `SHIPPED`(`S=A`)가 **공허참**이라 역순 사슬이면 답이 `SHIPPED` 가
 * 되고 `NOT_ALLOCATED` 가 **어떤 데이터로도 안 나온다**(R-7 ⓐ · R-11). 그래서 맨 앞에서 잘라 낸다.
 * ⛔ 이 분기를 아래로 옮기거나 `A < 0`·`A <= 0` 으로 바꾸지 마라 — `app.qty_t` 가
 *    `CHECK (VALUE >= 0)` 라 이 예외의 전부가 「같음」이다.
 * ⚠ 나머지 전부가 `PARTIALLY_ALLOCATED` 인 것은 `ck_shipment_request_qty`(`S <= A <= R`)가 있어
 *   그 자리에 닿는 조건이 곧 계약의 `0 < A < R` 이기 때문이다.
 */
export function shipmentProgressCode(totals: ShipmentProgressTotals): ShipmentProgressCode {
  const { requestedQty: r, allocatedQty: a, pickedQty: p, shippedQty: s } = totals;
  if (a.equals(ZERO)) return 'NOT_ALLOCATED';
  if (s.equals(a) && a.greaterThan(ZERO)) return 'SHIPPED';
  if (s.greaterThan(ZERO) && s.lessThan(a)) return 'PARTIALLY_SHIPPED';
  if (p.equals(a) && s.equals(ZERO)) return 'PICKED';
  if (a.equals(r) && p.lessThan(a)) return 'PICKING';
  return 'PARTIALLY_ALLOCATED';
}

/**
 * ⭐ **라인 하나의 `P`** — `pickedQtyOf` 의 SQL 짝이다(`- res.released_qty` 가 그 한 글자).
 * 아래 헤더 롤업이 이것을 합치고, 목록의 `pickingCompleteOnly`(라인 «전체»가 `P = A`)는 헤더
 * 4합계로 도출할 수 없어 **라인 축 그대로** 이것을 쓴다. ⛔ 사본을 더 만들지 마라 — §5-1 이
 * 「TS 와 SQL 두 벌을 **한 파일에** 나란히」라 못박은 자리다(셋째 벌이 갈리면 아무도 못 본다).
 */
export function shipmentLinePickedSql(lineAlias: string): string {
  return `(SELECT coalesce(sum(res.reserved_qty - res.released_qty), 0)
              FROM inventory.inventory_reservation res
             WHERE res.source_document_type_code = '${SHIPMENT_REQUEST_LINE}'
               AND res.source_document_id = ${lineAlias}.shipment_request_line_id)`;
}

/**
 * ⭐ 헤더 4수량 — 목록·요약이 `JOIN LATERAL (…) t ON TRUE` 로 단다(바깥 별칭 `sr`).
 * ⛔ `coalesce` 를 벗기지 마라 — 라인 0건이면 `sum` 이 NULL 이고 3값 논리로 비교가 UNKNOWN 이 되어
 *    그 작업지시가 **목록에서 통째로 사라진다**(README §6-3 ⑷).
 */
export const SHIPMENT_PROGRESS_TOTALS_SQL = `
    SELECT coalesce(sum(srl.requested_qty), 0) AS requested_qty,
           coalesce(sum(srl.allocated_qty), 0) AS allocated_qty,
           coalesce(sum(srl.shipped_qty), 0)   AS shipped_qty,
           coalesce(sum(${shipmentLinePickedSql('srl')}), 0) AS picked_qty
      FROM logistics.shipment_request_line srl
     WHERE srl.shipment_request_id = sr.shipment_request_id`;

/** 6값의 경계 — 위 if 사슬과 **같은 순서·같은 경계**. `PARTIALLY_ALLOCATED` 는 `ELSE` 로 나간다. */
const SQL_RULES: ReadonlyArray<readonly [ShipmentProgressCode, string]> = [
  ['NOT_ALLOCATED', 't.allocated_qty = 0'],
  ['SHIPPED', 't.shipped_qty = t.allocated_qty AND t.allocated_qty > 0'],
  ['PARTIALLY_SHIPPED', 't.shipped_qty > 0 AND t.shipped_qty < t.allocated_qty'],
  ['PICKED', 't.picked_qty = t.allocated_qty AND t.shipped_qty = 0'],
  ['PICKING', 't.allocated_qty = t.requested_qty AND t.picked_qty < t.allocated_qty'],
];

/**
 * `?shipmentProgressCode=` 필터와 `summary` 의 건수가 쓰는 식 — `… = $n` 한 줄로 건다. ⛔ 값별
 * 술어를 따로 적지 마라 — 「뒤가 이긴다」의 순서까지 다시 적어야 하고 그 순간 두 벌이 갈린다.
 */
export const SHIPMENT_PROGRESS_CASE_SQL = `CASE
${SQL_RULES.map(([code, sql]) => `      WHEN ${sql} THEN '${code}'`).join('\n')}
      ELSE 'PARTIALLY_ALLOCATED'
    END`;
