import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { filter } from '../../common/master';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryCountDetail,
  InventoryCountLineView,
  InventoryCountSummary,
  InventoryCountView,
  inventoryCountLineView,
  inventoryCountView,
} from './inventory-count-view';

export interface InventoryCountQuery {
  warehouseId?: unknown;
  plannedDateFrom?: string;
  plannedDateTo?: string;
  countTypeCode?: string;
  statusCode?: string;
  inProgressOnly?: unknown;
  page?: unknown;
  size?: unknown;
}

export interface InventoryCountLineQuery {
  locationId?: unknown;
  itemId?: unknown;
  uncountedOnly?: unknown;
  varianceOnly?: unknown;
  page?: unknown;
  size?: unknown;
}

type CountClient = Pick<Prisma.TransactionClient, 'inventory_count' | 'inventory_count_line'>;

@Injectable()
export class InventoryCountQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InventoryCountQuery): Promise<PagedResponse<InventoryCountView>> {
    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const where = inventoryCountWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.inventory_count.findMany({
        where,
        orderBy: [{ planned_date: 'desc' }, { inventory_count_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inventory_count.count({ where }),
    ]);
    return pagedResponse(rows.map(inventoryCountView), total, page);
  }

  async get(inventoryCountId: number): Promise<{ detail: InventoryCountDetail; versionNo: number }> {
    return this.getWithin(this.prisma, inventoryCountId);
  }

  /** 생성·마감은 커밋 전 응답까지 같은 멱등 트랜잭션에서 읽는다. */
  async getWithin(
    prisma: CountClient,
    inventoryCountId: number,
  ): Promise<{ detail: InventoryCountDetail; versionNo: number }> {
    const row = await prisma.inventory_count.findUnique({
      where: { inventory_count_id: inventoryCountId },
    });
    if (row === null) throw new NotFoundException('없는 재고 실사입니다.');
    return {
      detail: {
        inventoryCount: inventoryCountView(row),
        summary: await inventoryCountSummary(prisma, row.inventory_count_id, row.status_code),
      },
      versionNo: row.version_no,
    };
  }

  async lines(
    inventoryCountId: number,
    query: InventoryCountLineQuery,
  ): Promise<PagedResponse<InventoryCountLineView>> {
    const header = await this.prisma.inventory_count.findUnique({
      where: { inventory_count_id: inventoryCountId },
      select: { inventory_count_id: true, blind_count: true },
    });
    if (header === null) throw new NotFoundException('없는 재고 실사입니다.');

    const page = pageRequest({ page: number(query.page), size: number(query.size) });
    const where = inventoryCountLineWhere(header.inventory_count_id, query);
    const include = {
      item: { select: { item_code: true, item_name: true } },
      lot: { select: { lot_no: true } },
      location: { select: { location_code: true } },
    } as const;
    const [rows, total] = await Promise.all([
      this.prisma.inventory_count_line.findMany({
        where,
        include,
        orderBy: [{ line_no: 'asc' }, { inventory_count_line_id: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inventory_count_line.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => inventoryCountLineView(row, header.blind_count)),
      total,
      page,
    );
  }
}

export function inventoryCountWhere(query: InventoryCountQuery): Prisma.inventory_countWhereInput {
  const warehouseId = numeric('warehouseId', query.warehouseId);
  return {
    ...filter('warehouse_id', warehouseId),
    ...(query.countTypeCode === undefined ? {} : { count_type_code: query.countTypeCode }),
    ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    ...(boolean(query.inProgressOnly) ? { AND: [{ status_code: 'IN_PROGRESS' }] } : {}),
    ...plannedDateWhere(query.plannedDateFrom, query.plannedDateTo),
  };
}

export function inventoryCountLineWhere(
  inventoryCountId: bigint,
  query: InventoryCountLineQuery,
): Prisma.inventory_count_lineWhereInput {
  const locationId = numeric('locationId', query.locationId);
  const itemId = numeric('itemId', query.itemId);
  const filters: Prisma.inventory_count_lineWhereInput[] = [];
  if (boolean(query.uncountedOnly)) filters.push({ counted: false });
  if (boolean(query.varianceOnly)) {
    filters.push({ counted: true, variance_qty: { not: 0 } });
  }
  return {
    inventory_count_id: inventoryCountId,
    ...filter('location_id', locationId),
    ...filter('item_id', itemId),
    ...(filters.length === 0 ? {} : { AND: filters }),
  };
}

/** 상세과 close가 같은 판정을 공유한다. close는 잠근 tx를 넘긴다. */
export async function inventoryCountSummary(
  prisma: CountClient,
  inventoryCountId: bigint,
  statusCode: string,
): Promise<InventoryCountSummary> {
  const base = { inventory_count_id: inventoryCountId };
  const variance = { ...base, counted: true, variance_qty: { not: 0 } };
  const [plannedCount, countedCount, varianceCount, unadjustedVarianceCount] = await Promise.all([
    prisma.inventory_count_line.count({ where: base }),
    prisma.inventory_count_line.count({ where: { ...base, counted: true } }),
    prisma.inventory_count_line.count({ where: variance }),
    prisma.inventory_count_line.count({
      where: {
        ...variance,
        inventory_adjustment_line: {
          none: { inventory_adjustment: { status_code: 'POSTED' } },
        },
      },
    }),
  ]);
  const uncountedCount = plannedCount - countedCount;
  const closeBlockedReasonCode = blockedReason(statusCode, uncountedCount, unadjustedVarianceCount);
  return {
    plannedCount,
    countedCount,
    uncountedCount,
    varianceCount,
    closable: closeBlockedReasonCode === null,
    closeBlockedReasonCode,
  };
}

export function blockedReason(
  statusCode: string,
  uncountedCount: number,
  unadjustedVarianceCount: number,
): string | null {
  if (statusCode === 'COMPLETED') return ERROR_CODE.ALREADY_CLOSED;
  if (statusCode !== 'IN_PROGRESS') return ERROR_CODE.STATE_LOCKED;
  if (uncountedCount > 0) return ERROR_CODE.COUNT_REMAINING;
  if (unadjustedVarianceCount > 0) return ERROR_CODE.VARIANCE_UNADJUSTED;
  return null;
}

function plannedDateWhere(from?: string, to?: string): Prisma.inventory_countWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    planned_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}

function numeric(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw one(field(name, ERROR_CODE.INVALID, '숫자여야 합니다.'));
}

function number(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value: unknown): boolean {
  return value === true || value === 'true';
}
