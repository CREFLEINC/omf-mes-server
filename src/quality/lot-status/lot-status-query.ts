/**
 * `GET /quality/lot-statuses` 의 SQL — 원시 SQL 이다(0단계 선례 `src/inventory/balance/balance-query.ts`).
 *
 * ⛔ **왜 raw SQL 인가.** 창고·수량 4칸(`inventory_balance`)과 보류 요약·최근 전이(`lot_hold`)를
 * `trace.lot` 한 행으로 접어야 하는데, 그 접기(`CASE WHEN count(DISTINCT …) = 1`)와
 * `EXISTS`/`NOT EXISTS` 필터는 Prisma 로 표현할 수 없다.
 *
 * ⭐ **§0 #5 판정** — `heldQty`·`availableQty` 는 `inventory_balance.blocked_qty`/`available_qty`
 * 를 쓰지 않는다(계약이 두 자리에서 못 박았다) — `lot_hold` 가 정본이다. 창고·위치·단위는 LOT
 * 하나에 잔액 행이 여럿이면 «비운다»(값이 하나일 때만 싣는다 · 문의 075).
 *
 * ⛔ 식별자(표·열 이름)는 이 파일의 상수·리터럴에서만 온다. 요청 값은 전부 파라미터로 묶는다.
 */

export const SORTS = [
  'lotNoAsc',
  'lotNoDesc',
  'itemAsc',
  'itemDesc',
  'latestTransitionAsc',
  'latestTransitionDesc',
] as const;
export type LotStatusSort = (typeof SORTS)[number];

export interface LotStatusFilters {
  lotStatusCode?: string;
  lotTypeCode?: string;
  itemId?: number;
  warehouseId?: number;
  locationId?: number;
  plantId?: number;
  heldOnly?: boolean;
  excludeFullyHeld?: boolean;
  transitionFrom?: string;
  transitionTo?: string;
  q?: string;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/** 조건을 모으며 파라미터 번호를 붙인다 — 값이 SQL 문자열에 섞이지 않는다. */
class Conditions {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];

  add(template: (placeholder: string) => string, value: unknown): void {
    this.params.push(value);
    this.parts.push(template(`$${this.params.length}`));
  }

  raw(part: string): void {
    this.parts.push(part);
  }

  /** WHERE 밖(예: LIMIT·OFFSET)에서 값 하나를 파라미터로 묶는다. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  get where(): string {
    return this.parts.length === 0 ? 'TRUE' : this.parts.join('\n   AND ');
  }
}

/**
 * `FROM` 절 — LATERAL 셋.
 * ⓐ 잔액 접기(창고·위치·단위는 값이 하나일 때만 · `on_hand_qty` 는 합계)
 * ⓑ 열린 보류 집계(`hold_qty IS NULL` 인 전량 보류는 따로 센다 — `SUM` 이 NULL 을 건너뛰어
 *   전량 보류 하나뿐이면 `partial_hold_qty` 가 NULL 이 되는 함정을 뷰에서 가른다)
 * ⓒ 최근 전이 — 등록(`held_at`)과 해제(`released_at`)를 한 사건 목록으로 펴서 최댓값 1건.
 *   계약 문자 그대로 `lot_hold` 최대 시각이다(문의 076).
 */
const FROM = `
    FROM trace.lot l
    LEFT JOIN LATERAL (
      SELECT sum(b.on_hand_qty) AS on_hand_qty,
             CASE WHEN count(DISTINCT b.uom_id) = 1 THEN min(b.uom_id) END AS uom_id,
             CASE WHEN count(DISTINCT b.warehouse_id) = 1 THEN min(b.warehouse_id) END AS warehouse_id,
             CASE WHEN count(DISTINCT b.location_id) = 1 THEN min(b.location_id) END AS location_id
        FROM inventory.inventory_balance b
       WHERE b.lot_id = l.lot_id
    ) bal ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS open_hold_count,
             bool_or(h.hold_qty IS NULL) AS fully_held,
             sum(h.hold_qty) FILTER (WHERE h.hold_qty IS NOT NULL) AS partial_hold_qty
        FROM trace.lot_hold h
       WHERE h.lot_id = l.lot_id AND h.released_at IS NULL
    ) hold ON TRUE
    LEFT JOIN LATERAL (
      SELECT e.event_at, e.reason_code
        FROM (
          SELECT he.held_at AS event_at, he.reason_code FROM trace.lot_hold he WHERE he.lot_id = l.lot_id
          UNION ALL
          SELECT hr.released_at, hr.reason_code FROM trace.lot_hold hr
           WHERE hr.lot_id = l.lot_id AND hr.released_at IS NOT NULL
        ) e
       ORDER BY e.event_at DESC
       LIMIT 1
    ) trans ON TRUE`;

/**
 * ⭐ **§0 #5 · SQL 3값 논리** — `heldOnly`/`excludeFullyHeld` 는 `EXISTS`/`NOT EXISTS` 로 쓴다.
 * 잔액이 없는 LOT(L7)까지 살리려면 창고·위치 필터도 접힌 칸이 아니라 `EXISTS` 로 건다 —
 * 접힌 칸(`bal.warehouse_id`)은 창고가 둘이면 NULL 이라 `NOT (…)` 로 걸면 그 LOT 이 통째로 사라진다.
 */
function conditionsOf(filters: LotStatusFilters): Conditions {
  const c = new Conditions();
  if (filters.lotStatusCode !== undefined) c.add((p) => `l.status_code = ${p}`, filters.lotStatusCode);
  if (filters.lotTypeCode !== undefined) c.add((p) => `l.lot_type_code = ${p}`, filters.lotTypeCode);
  if (filters.itemId !== undefined) c.add((p) => `l.item_id = ${p}::bigint`, filters.itemId);
  if (filters.plantId !== undefined) c.add((p) => `l.plant_id = ${p}::bigint`, filters.plantId);
  if (filters.warehouseId !== undefined) {
    c.add(
      (p) => `EXISTS (SELECT 1 FROM inventory.inventory_balance wb WHERE wb.lot_id = l.lot_id AND wb.warehouse_id = ${p}::bigint)`,
      filters.warehouseId,
    );
  }
  if (filters.locationId !== undefined) {
    c.add(
      (p) => `EXISTS (SELECT 1 FROM inventory.inventory_balance lb WHERE lb.lot_id = l.lot_id AND lb.location_id = ${p}::bigint)`,
      filters.locationId,
    );
  }
  if (filters.heldOnly === true) {
    c.raw('EXISTS (SELECT 1 FROM trace.lot_hold ho WHERE ho.lot_id = l.lot_id AND ho.released_at IS NULL)');
  }
  if (filters.excludeFullyHeld === true) {
    c.raw(
      'NOT EXISTS (SELECT 1 FROM trace.lot_hold fh WHERE fh.lot_id = l.lot_id AND fh.released_at IS NULL AND fh.hold_qty IS NULL)',
    );
  }
  // ⛔ 「미만」 반열림(공유계약 L-3-1) — transitionTo 와 같은 시각의 행은 뺀다.
  if (filters.transitionFrom !== undefined) c.add((p) => `trans.event_at >= ${p}::timestamptz`, filters.transitionFrom);
  if (filters.transitionTo !== undefined) c.add((p) => `trans.event_at < ${p}::timestamptz`, filters.transitionTo);
  if (filters.q !== undefined) c.add((p) => `l.lot_no ILIKE ${p}`, `%${filters.q}%`);
  return c;
}

/**
 * ⭐ **R-10** — `latestTransitionAt` 은 NULL 일 수 있다(보류를 한 번도 안 겪은 LOT). 방향과
 * 무관하게 `NULLS LAST` 로 고정하지 않으면 DESC 에서 NULL 이 맨 위로 와 페이지가 어긋난다
 * (선례 `src/maintenance/inspection/inspection-query.service.ts:128`). 세 정렬축 전부 `lot_id`
 * 로 동률을 깬다 — `lot_no`·`item_id` 는 물리로 유일함이 보장되지 않는다.
 */
const ORDER_BY: Record<LotStatusSort, string> = {
  lotNoAsc: 'l.lot_no ASC, l.lot_id ASC',
  lotNoDesc: 'l.lot_no DESC, l.lot_id DESC',
  itemAsc: 'l.item_id ASC, l.lot_id ASC',
  itemDesc: 'l.item_id DESC, l.lot_id DESC',
  latestTransitionAsc: 'trans.event_at ASC NULLS LAST, l.lot_id ASC',
  latestTransitionDesc: 'trans.event_at DESC NULLS LAST, l.lot_id DESC',
};

export const SELECT_COLUMNS = `
      l.lot_id, l.lot_no, l.item_id, l.lot_type_code, l.status_code, l.version_no,
      bal.on_hand_qty, bal.uom_id, bal.warehouse_id, bal.location_id,
      hold.open_hold_count, hold.fully_held, hold.partial_hold_qty,
      trans.event_at AS latest_transition_at, trans.reason_code AS latest_reason_code`;

export function lotStatusRowsQuery(
  filters: LotStatusFilters,
  sort: LotStatusSort,
  page: { skip: number; take: number },
): BuiltQuery {
  const c = conditionsOf(filters);
  const limit = c.param(page.take);
  const offset = c.param(page.skip);
  const sql = `
    SELECT ${SELECT_COLUMNS}
      ${FROM}
     WHERE ${c.where}
     ORDER BY ${ORDER_BY[sort]}
     LIMIT ${limit} OFFSET ${offset}`;
  return { sql, params: c.params };
}

/** `page.total` 은 필터 «전체» 기준이다 — 페이지 안에서 세지 않는다. */
export function lotStatusCountQuery(filters: LotStatusFilters): BuiltQuery {
  const c = conditionsOf(filters);
  const sql = `SELECT count(*)::int AS total ${FROM} WHERE ${c.where}`;
  return { sql, params: c.params };
}
