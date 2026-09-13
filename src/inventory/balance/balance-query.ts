import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

/**
 * 잔액 집계 SQL 을 짓는다.
 *
 * ⛔ **왜 raw SQL 인가.** 축을 접어 합치면서 `itemCode`·`lotNo` 같은 «마스터 조인 열»로
 * 정렬해야 하는데 Prisma `groupBy` 로는 그 열을 만질 수 없다. 요약도 페이지가 아니라
 * 필터 전체 기준이라 같은 조건을 두 번 쓴다 — 조건을 한 자리에서 짓는 편이 안전하다.
 *
 * ⛔ 식별자(표·열 이름)는 **이 파일의 상수에서만** 온다. 요청 값은 전부 파라미터로 묶는다.
 */

export type GroupBy = 'ITEM' | 'LOT' | 'LOCATION';

export const SORTS = [
  'itemCode',
  'lotNo',
  'locationCode',
  'onHandQty',
  'availableQty',
  'earliestExpiryDate',
  'manufacturedAt',
] as const;
export type BalanceSort = (typeof SORTS)[number];

/**
 * 묶는 키. ⛔ 소유 구분(`ownership_type_code`·`owner_partner_id`)은 **어떤 축에서도 합치지
 * 않는다**(계약) — 남의 물건과 우리 물건이 한 줄이 되면 잔액이 거짓말을 한다.
 */
const GROUP_KEYS: Record<GroupBy, string[]> = {
  ITEM: ['b.item_id', 'b.ownership_type_code', 'b.owner_partner_id'],
  LOT: ['b.item_id', 'b.ownership_type_code', 'b.owner_partner_id', 'b.lot_id'],
  LOCATION: [
    'b.item_id',
    'b.ownership_type_code',
    'b.owner_partner_id',
    'b.lot_id',
    'b.warehouse_id',
    'b.location_id',
  ],
};

/** 키가 아닌 축 — 그 줄 안에서 값이 하나뿐일 때만 싣고, 여럿이면 비운다. */
const FOLDABLE = [
  'legal_entity_id',
  'business_unit_id',
  'plant_id',
  'warehouse_id',
  'location_id',
  'lot_id',
  'quality_status_code',
  'inventory_status_code',
] as const;

export interface BalanceFilters {
  plantId?: bigint;
  warehouseId?: number;
  itemId?: number;
  lotId?: number;
  locationId?: number;
  qualityStatusCode?: string;
  inventoryStatusCode?: string;
  ownershipTypeCode?: string;
  mesCategoryCode?: string;
  includeZero?: boolean;
  heldOnly?: boolean;
  /** 유효기한 축 — 이 둘은 「판정 불가」 계수와 짝이라 따로 둔다. */
  expiryDateTo?: string;
  expiryWithinDays?: number;
  /** 임박 판정의 기준일. 공장 로컬 오늘이다. */
  today: string;
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

  get where(): string {
    return this.parts.length === 0 ? 'TRUE' : this.parts.join('\n   AND ');
  }
}

/**
 * `FROM` 절 — 마스터를 함께 읽는다. 화면이 식별자를 사람이 읽는 값으로 바꾸려 마스터를
 * 다시 부르지 않게 하는 것이 계약의 뜻이다.
 *
 * ⚠ `lot` 은 LEFT JOIN 이다 — LOT 관리하지 않는 품목의 잔액에는 LOT 이 없다.
 */
const FROM = `
    FROM inventory.inventory_balance b
    JOIN mdm.item i ON i.item_id = b.item_id
    JOIN mdm.warehouse w ON w.warehouse_id = b.warehouse_id
    JOIN mdm.location loc ON loc.location_id = b.location_id
    LEFT JOIN trace.lot l ON l.lot_id = b.lot_id
    LEFT JOIN LATERAL (
      SELECT 1 AS held FROM trace.lot_hold h
       WHERE h.lot_id = b.lot_id AND h.released_at IS NULL LIMIT 1
    ) hh ON TRUE`;

function conditionsOf(filters: BalanceFilters, withExpiry: boolean): Conditions {
  const c = new Conditions();
  if (filters.plantId !== undefined) c.add((p) => `b.plant_id = ${p}::bigint`, filters.plantId);
  if (filters.warehouseId !== undefined) c.add((p) => `b.warehouse_id = ${p}::bigint`, filters.warehouseId);
  if (filters.itemId !== undefined) c.add((p) => `b.item_id = ${p}::bigint`, filters.itemId);
  if (filters.lotId !== undefined) c.add((p) => `b.lot_id = ${p}::bigint`, filters.lotId);
  if (filters.locationId !== undefined) c.add((p) => `b.location_id = ${p}::bigint`, filters.locationId);
  if (filters.qualityStatusCode !== undefined) c.add((p) => `b.quality_status_code = ${p}`, filters.qualityStatusCode);
  if (filters.inventoryStatusCode !== undefined) c.add((p) => `b.inventory_status_code = ${p}`, filters.inventoryStatusCode);
  if (filters.ownershipTypeCode !== undefined) c.add((p) => `b.ownership_type_code = ${p}`, filters.ownershipTypeCode);
  if (filters.mesCategoryCode !== undefined) c.add((p) => `i.mes_category_code = ${p}`, filters.mesCategoryCode);
  // 「잔액이 0 인 줄도 내릴지」 — 기본은 감춘다(계약).
  if (filters.heldOnly === true) c.raw('hh.held IS NOT NULL');
  if (filters.includeZero !== true) c.raw('b.on_hand_qty <> 0');

  // ⚠ 유효기한 축은 유효기한이 «있는» LOT 만 판정할 수 있다. 없는 LOT 은 여기서 빠지고
  // 응답이 그 수를 따로 센다(공유계약 L-8) — 「판정 불가」를 「정상」으로 보이지 않게 한다.
  if (withExpiry) {
    if (filters.expiryDateTo !== undefined) c.add((p) => `l.expiry_date <= ${p}::date`, filters.expiryDateTo);
    if (filters.expiryWithinDays !== undefined) {
      c.params.push(filters.today, filters.expiryWithinDays);
      c.raw(
        `l.expiry_date IS NOT NULL AND l.expiry_date <= ($${c.params.length - 1}::date + ($${c.params.length}::int * INTERVAL '1 day'))`,
      );
    }
  }
  return c;
}

/** 줄 하나 — 접힌 축은 값이 하나일 때만 싣는다. */
function foldedColumns(groupBy: GroupBy): string {
  const keys = new Set(GROUP_KEYS[groupBy]);
  return FOLDABLE.map((column) =>
    keys.has(`b.${column}`)
      ? `b.${column}`
      : `CASE WHEN count(DISTINCT b.${column}) = 1 THEN min(b.${column}::text) END AS ${column}`,
  ).join(',\n           ');
}

export function balanceRowsQuery(groupBy: GroupBy, filters: BalanceFilters): BuiltQuery {
  const c = conditionsOf(filters, true);
  const keys = GROUP_KEYS[groupBy];
  const sql = `
    SELECT ${keys.join(', ')},
           ${foldedColumns(groupBy)},
           min(i.item_code) AS item_code,
           min(i.item_name) AS item_name,
           CASE WHEN count(DISTINCT b.lot_id) = 1 THEN min(l.lot_no) END AS lot_no,
           CASE WHEN count(DISTINCT b.warehouse_id) = 1 THEN min(w.warehouse_name) END AS warehouse_name,
           CASE WHEN count(DISTINCT b.location_id) = 1 THEN min(loc.location_code) END AS location_code,
           CASE WHEN count(DISTINCT b.location_id) = 1 THEN min(loc.location_name) END AS location_name,
           CASE WHEN count(*) = 1 THEN min(b.inventory_balance_id) END AS inventory_balance_id,
           min(b.uom_id) AS uom_id,
           sum(b.on_hand_qty) AS on_hand_qty,
           sum(b.reserved_qty) AS reserved_qty,
           sum(b.picked_qty) AS picked_qty,
           sum(b.blocked_qty) AS blocked_qty,
           sum(b.on_hand_qty - b.reserved_qty - b.picked_qty - b.blocked_qty) AS available_qty,
           max(b.last_transaction_at) AS last_transaction_at,
           min(l.expiry_date) AS earliest_expiry_date,
           max(l.manufactured_at) AS manufactured_at,
           count(DISTINCT CASE WHEN hh.held IS NOT NULL THEN b.lot_id END)::int AS held_lot_count
      ${FROM}
     WHERE ${c.where}
     GROUP BY ${keys.join(', ')}`;
  return { sql, params: c.params };
}

/**
 * 요약과 「판정 불가」 계수. ⚠ 유효기한 필터를 **빼고** 센다 — 「임박 판정을 할 수 없는
 * LOT 이 몇인가」가 그 계수의 뜻이라, 임박 필터로 걸러낸 뒤 세면 언제나 0 이 된다.
 */
export function balanceSummaryQuery(filters: BalanceFilters): BuiltQuery {
  const c = conditionsOf(filters, false);
  const sql = `
    SELECT count(DISTINCT b.item_id)::int AS item_count,
           count(DISTINCT b.lot_id)::int AS lot_count,
           coalesce(sum(b.on_hand_qty), 0) AS on_hand_qty,
           coalesce(sum(b.on_hand_qty - b.reserved_qty - b.picked_qty - b.blocked_qty), 0) AS available_qty,
           coalesce(sum(b.blocked_qty), 0) AS blocked_qty,
           count(DISTINCT CASE WHEN b.lot_id IS NOT NULL AND l.expiry_date IS NULL THEN b.lot_id END)::int
             AS expiry_unknown_count
      ${FROM}
     WHERE ${c.where}`;
  return { sql, params: c.params };
}

/** 창고·위치·품목·LOT 중 하나는 있어야 한다. 위치도 단일 재고 범위다. */
export function assertScoped(filters: Pick<BalanceFilters, 'warehouseId' | 'locationId' | 'itemId' | 'lotId'>): void {
  if (filters.warehouseId !== undefined || filters.locationId !== undefined || filters.itemId !== undefined || filters.lotId !== undefined) {
    return;
  }
  const errors: ErrorItem[] = ['warehouseId', 'itemId', 'lotId'].map((field) => ({
    scope: 'field',
    field,
    code: ERROR_CODE.REQUIRED,
    message: '창고·품목·LOT 중 적어도 하나로 좁혀야 합니다.',
  }));
  throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
