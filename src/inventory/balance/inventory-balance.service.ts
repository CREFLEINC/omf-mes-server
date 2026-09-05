import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PageMeta, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BalanceFilters,
  BalanceSort,
  GroupBy,
  SORTS,
  assertScoped,
  balanceRowsQuery,
  balanceSummaryQuery,
} from './balance-query';

/**
 * 재고 잔액 — 원장의 «지금». 화면은 `W-01-07`(재고 현황)·`M-01-04`(현장 조회)가 쓴다.
 *
 * ⛔ 잔액은 posting 이 쌓은 결과이고 이 서비스는 읽기만 한다 — 잔액을 직접 고치는 길은
 * 어디에도 없다(결정 08 · 정정은 역트랜잭션이다).
 */

export interface BalanceQuery {
  warehouseId?: number; itemId?: number; lotId?: number; locationId?: number;
  groupBy?: string;
  qualityStatusCode?: string; inventoryStatusCode?: string;
  ownershipTypeCode?: string; mesCategoryCode?: string;
  includeZero?: boolean | string; heldOnly?: boolean | string;
  expiryDateTo?: string; expiryWithinDays?: number;
  sort?: string;
  page?: number; size?: number;
}

/** 계약 `InventoryBalance` 와 동형. 접힌 축은 비어 온다. */
interface BalanceView {
  groupBy: GroupBy;
  inventoryBalanceId: number | null;
  legalEntityId: number | null;
  businessUnitId: number | null;
  plantId: number | null;
  warehouseId: number | null;
  locationId: number | null;
  itemId: number;
  lotId: number | null;
  qualityStatusCode: string | null;
  inventoryStatusCode: string | null;
  ownershipTypeCode: string;
  ownerPartnerId: number | null;
  onHandQty: number;
  reservedQty: number;
  pickedQty: number;
  blockedQty: number;
  availableQty: number;
  uomId: number;
  heldLotCount: number;
  lastTransactionAt: string | null;
  earliestExpiryDate: string | null;
  itemCode: string;
  itemName: string;
  lotNo: string | null;
  locationCode: string | null;
  warehouseName: string | null;
  locationName: string | null;
}

/** 계약 `InventoryBalanceSummary` — ⚠ 페이지가 아니라 필터 «전체» 기준이다. */
interface BalanceSummary {
  itemCount: number;
  lotCount: number;
  onHandQty: number;
  availableQty: number;
  blockedQty: number;
  asOf: string;
}

export interface BalanceResponse {
  summary: BalanceSummary;
  items: BalanceView[];
  page: PageMeta;
  expiryUnknownCount: number;
}

/**
 * ⚠ `manufacturedAt` 은 계약 `InventoryBalance` 에 «없는» 칸인데 정렬 축에는 있다
 * (`sort=manufacturedAt`). 응답에 실으면 계약에 없는 것을 내리는 셈이라, 안에서만 들고
 * 다니다 마지막에 뗀다.
 */
type SortableRow = BalanceView & { manufacturedAt: string | null };

/** 정렬 축이 붙는 칸 — 접힌 줄에서는 비어 있을 수 있어 전부 「없으면 뒤」로 다룬다. */
type SortKey = { of: (row: SortableRow) => string | number | null; text: boolean };

const SORT_KEYS: Record<BalanceSort, SortKey> = {
  itemCode: { of: (r) => r.itemCode, text: true },
  lotNo: { of: (r) => r.lotNo, text: true },
  locationCode: { of: (r) => r.locationCode, text: true },
  onHandQty: { of: (r) => r.onHandQty, text: false },
  availableQty: { of: (r) => r.availableQty, text: false },
  earliestExpiryDate: { of: (r) => r.earliestExpiryDate, text: true },
  manufacturedAt: { of: (r) => r.manufacturedAt, text: true },
};

type RawRow = Record<string, unknown> & { manufactured_at: Date | null };

@Injectable()
export class InventoryBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: BalanceQuery): Promise<BalanceResponse> {
    const filters = await this.filtersOf(query);
    assertScoped(filters);
    const groupBy = assertGroupBy(query.groupBy);
    const sort = assertSort(query.sort);
    const page = pageRequest({ page: loose(query.page), size: loose(query.size) });

    const rowsQuery = balanceRowsQuery(groupBy, filters);
    const summaryQuery = balanceSummaryQuery(filters);
    const [raw, summaryRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<RawRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<RawRow[]>(summaryQuery.sql, ...summaryQuery.params),
    ]);

    const items = raw.map((row) => view(row, groupBy));
    items.sort(sorter(sort));

    const s = summaryRows[0] ?? {};
    return {
      summary: {
        itemCount: int(s.item_count),
        lotCount: int(s.lot_count),
        onHandQty: num(s.on_hand_qty),
        availableQty: num(s.available_qty),
        blockedQty: num(s.blocked_qty),
        // 「서버 집계 기준 시각 — 브라우저 수신 시각이 아니다」(계약 · 공유계약 L-5).
        asOf: new Date().toISOString(),
      },
      items: items.slice(page.skip, page.skip + page.take).map(stripSortOnly),
      page: { page: page.page, size: page.size, total: items.length },
      expiryUnknownCount: int(s.expiry_unknown_count),
    };
  }

  /**
   * 질의를 필터로 옮기며 숫자 축을 가른다. 「임박」의 기준일은 **공장 로컬 오늘**이다 —
   * 창고를 주면 그 창고의 공장으로 푼다(CLAUDE.md · `plant.timezone_code`).
   */
  private async filtersOf(query: BalanceQuery): Promise<BalanceFilters> {
    const warehouseId = assertId('warehouseId', query.warehouseId);
    return {
      warehouseId,
      itemId: assertId('itemId', query.itemId),
      lotId: assertId('lotId', query.lotId),
      locationId: assertId('locationId', query.locationId),
      ...pick(query, 'qualityStatusCode', 'inventoryStatusCode', 'ownershipTypeCode', 'mesCategoryCode'),
      includeZero: bool(query.includeZero),
      heldOnly: bool(query.heldOnly),
      ...(query.expiryDateTo === undefined
        ? {}
        : { expiryDateTo: assertDateString('expiryDateTo', query.expiryDateTo) }),
      expiryWithinDays: assertId('expiryWithinDays', query.expiryWithinDays),
      today: await this.today(warehouseId),
    };
  }

  private async today(warehouseId: number | undefined): Promise<string> {
    const plant =
      warehouseId === undefined
        ? null
        : (
            await this.prisma.warehouse.findUnique({
              where: { warehouse_id: warehouseId },
              select: { plant: { select: { timezone_code: true } } },
            })
          )?.plant ?? null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: plant?.timezone_code ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}

/**
 * ⛔ 값이 없는 줄은 «방향과 무관하게» 뒤로 보낸다 — 유효기한 없는 LOT 을 섞으면 FEFO
 * 순서가 거짓말을 한다(공유계약 L-10 · M-04-01 §5-2). 접힌 줄의 `lotNo` 도 같다.
 */
function sorter(sort: BalanceSort | undefined): (a: SortableRow, b: SortableRow) => number {
  const byCode = (a: SortableRow, b: SortableRow): number =>
    a.itemCode.localeCompare(b.itemCode) ||
    (a.lotNo ?? '').localeCompare(b.lotNo ?? '') ||
    (a.locationCode ?? '').localeCompare(b.locationCode ?? '');
  if (sort === undefined) return byCode;

  const key = SORT_KEYS[sort];
  const descending = sort === 'onHandQty' || sort === 'availableQty';
  return (a, b) => {
    const left = key.of(a);
    const right = key.of(b);
    if (left === null && right === null) return byCode(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    const compared = key.text
      ? String(left).localeCompare(String(right))
      : Number(left) - Number(right);
    return (descending ? -compared : compared) || byCode(a, b);
  };
}

function view(row: RawRow, groupBy: GroupBy): SortableRow {
  return {
    groupBy,
    inventoryBalanceId: id(row.inventory_balance_id),
    legalEntityId: id(row.legal_entity_id),
    businessUnitId: id(row.business_unit_id),
    plantId: id(row.plant_id),
    warehouseId: id(row.warehouse_id),
    locationId: id(row.location_id),
    itemId: Number(row.item_id),
    lotId: id(row.lot_id),
    qualityStatusCode: text(row.quality_status_code),
    inventoryStatusCode: text(row.inventory_status_code),
    ownershipTypeCode: String(row.ownership_type_code),
    ownerPartnerId: id(row.owner_partner_id),
    onHandQty: num(row.on_hand_qty),
    reservedQty: num(row.reserved_qty),
    pickedQty: num(row.picked_qty),
    blockedQty: num(row.blocked_qty),
    availableQty: num(row.available_qty),
    uomId: Number(row.uom_id),
    heldLotCount: int(row.held_lot_count),
    lastTransactionAt: row.last_transaction_at instanceof Date ? row.last_transaction_at.toISOString() : null,
    earliestExpiryDate: dateOnly(row.earliest_expiry_date),
    itemCode: String(row.item_code),
    itemName: String(row.item_name),
    lotNo: text(row.lot_no),
    locationCode: text(row.location_code),
    warehouseName: text(row.warehouse_name),
    locationName: text(row.location_name),
    // 계약에 없는 칸이라 응답에 싣지 않고 정렬에만 쓴다.
    manufacturedAt: row.manufactured_at instanceof Date ? row.manufactured_at.toISOString() : null,
  };
}

/** 계약에 없는 정렬용 칸을 뗀다 — 밖으로는 계약이 적은 것만 나간다. */
function stripSortOnly(row: SortableRow): BalanceView {
  const { manufacturedAt: _sortOnly, ...contractShape } = row;
  return contractShape;
}

function assertGroupBy(value: string | undefined): GroupBy {
  if (value === undefined) return 'ITEM';
  if (value === 'ITEM' || value === 'LOT' || value === 'LOCATION') return value;
  throw badRequest('groupBy', 'ITEM · LOT · LOCATION 중 하나입니다.');
}

function assertSort(value: string | undefined): BalanceSort | undefined {
  if (value === undefined) return undefined;
  if ((SORTS as readonly string[]).includes(value)) return value as BalanceSort;
  // 「지정된 열만 받는다」(계약 · 공유계약 L-4) — 임의 열 정렬은 인덱스가 없다.
  throw badRequest('sort', `${SORTS.join(' · ')} 중 하나입니다.`);
}

function assertDateString(field: string, value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return value;
  throw badRequest(field, 'YYYY-MM-DD 형식입니다.');
}

/** 숫자 축 — 글자가 섞이면 400 이다(그냥 넘기면 SQL 캐스팅이 500 으로 샌다). */
function assertId(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw badRequest(field, '숫자여야 합니다.');
}

function badRequest(field: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field, code: ERROR_CODE.INVALID, message },
  ]);
}

function pick<T extends object, K extends keyof T>(source: T, ...keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function bool(value: boolean | string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function loose(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function id(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function int(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** `@db.Date` 는 UTC 자정으로 온다 — 시각을 붙이면 하루가 어긋난다. */
function dateOnly(value: unknown): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : null;
}
