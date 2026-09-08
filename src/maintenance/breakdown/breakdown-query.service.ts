import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { maintenanceDateRange } from '../maintenance-calendar';
import {
  BREAKDOWN_INCLUDE,
  BreakdownDetailAggregate,
  BreakdownView,
  breakdownView,
} from './breakdown-view';

export interface BreakdownQuery {
  equipmentId?: number;
  statusCode?: string;
  openOnly?: boolean;
  reportedFrom?: string;
  reportedTo?: string;
  sort?: string;
  page?: number;
  size?: number;
  withoutMaintenanceOrder?: boolean;
}

export type BreakdownList = PagedResponse<BreakdownView> & { totalCount: number };
type BreakdownId = { breakdown_id: bigint };
type BreakdownPlant = { plant_id: bigint; timezone_code: string; has_missing_time: boolean };
type OrderLink = { breakdown_id: bigint; maintenance_order_id: bigint };
type DowntimeAggregate = {
  linked_downtime_count: number;
  open_linked_downtime_count: number;
  closed_seconds: Prisma.Decimal;
};

const BREAKDOWN_FROM = Prisma.sql`
  FROM maintenance.breakdown b
  JOIN mdm.equipment e ON e.equipment_id = b.equipment_id
  JOIN mdm.plant p ON p.plant_id = e.plant_id`;

@Injectable()
export class BreakdownQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: BreakdownQuery): Promise<BreakdownList> {
    const page = pageRequest(query);
    if (query.sort !== undefined && query.sort !== 'elapsedDesc') {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field('sort', ERROR_CODE.INVALID, '지원하지 않는 고장 정렬입니다.'),
      ]);
    }
    if (query.openOnly === false) {
      const missing = (['reportedFrom', 'reportedTo'] as const)
        .filter((name) => query[name] === undefined)
        .map((name) => field(name, ERROR_CODE.REQUIRED, '고장 조회 기간이 필요합니다.'));
      if (missing.length) throw new ContractException(HttpStatus.BAD_REQUEST, missing);
    }
    if (query.reportedFrom && query.reportedTo && query.reportedFrom > query.reportedTo)
      return { ...pagedResponse<BreakdownView>([], 0, page), totalCount: 0 };

    return this.prisma.$transaction(
      async (tx) => {
        const conditions = [Prisma.sql`TRUE`];
        if (query.equipmentId !== undefined)
          conditions.push(Prisma.sql`b.equipment_id = ${query.equipmentId}`);
        if (query.statusCode !== undefined)
          conditions.push(Prisma.sql`b.status_code = ${query.statusCode}`);
        if (query.openOnly !== false) conditions.push(Prisma.sql`b.status_code <> 'DONE'`);
        if (query.withoutMaintenanceOrder === true) {
          conditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM maintenance.maintenance_order o
            WHERE o.breakdown_id = b.breakdown_id
          )`);
          conditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM maintenance.maintenance_order_trigger t
            WHERE t.trigger_type_code = 'BREAKDOWN' AND t.source_id = b.breakdown_id
          )`);
        }

        if (query.reportedFrom !== undefined || query.reportedTo !== undefined) {
          const plants = await tx.$queryRaw<BreakdownPlant[]>(Prisma.sql`
            SELECT p.plant_id, p.timezone_code,
                   bool_or(b.reported_at IS NULL) AS has_missing_time
            ${BREAKDOWN_FROM} WHERE ${Prisma.join(conditions, ' AND ')}
            GROUP BY p.plant_id, p.timezone_code`);
          const ranges = plants.map((plant) => {
            if (plant.has_missing_time) throw new Error('Missing required breakdown time');
            const range = maintenanceDateRange(
              query.reportedFrom,
              query.reportedTo,
              plant.timezone_code,
            );
            const bounds = [Prisma.sql`p.plant_id = ${plant.plant_id}`];
            if (range.gte) bounds.push(Prisma.sql`b.reported_at >= ${range.gte}`);
            if (range.lt) bounds.push(Prisma.sql`b.reported_at < ${range.lt}`);
            return Prisma.sql`(${Prisma.join(bounds, ' AND ')})`;
          });
          conditions.push(
            ranges.length ? Prisma.sql`(${Prisma.join(ranges, ' OR ')})` : Prisma.sql`FALSE`,
          );
        }

        const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
        const [ids, counts] = await Promise.all([
          tx.$queryRaw<BreakdownId[]>(Prisma.sql`
            SELECT b.breakdown_id ${BREAKDOWN_FROM} ${where}
            ORDER BY b.reported_at ASC, b.breakdown_id ASC
            LIMIT ${page.take} OFFSET ${page.skip}`),
          tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
            SELECT count(*) AS total ${BREAKDOWN_FROM} ${where}`),
        ]);
        const pageIds = ids.map(({ breakdown_id }) => breakdown_id);
        const [rows, links] = await Promise.all([
          tx.breakdown.findMany({
            where: { breakdown_id: { in: pageIds } },
            include: BREAKDOWN_INCLUDE,
          }),
          this.orderLinks(tx, pageIds),
        ]);
        const byId = new Map(rows.map((row) => [row.breakdown_id, row]));
        const orders = orderIdsByBreakdown(links);
        const items = pageIds.map((id) => {
          const row = byId.get(id);
          if (!row) throw new Error('Breakdown disappeared from read snapshot');
          return breakdownView(row, singleOrderId(orders.get(id)));
        });
        const total = Number(counts[0].total);
        return { ...pagedResponse(items, total, page), totalCount: total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(breakdownId: number): Promise<{ view: BreakdownView; versionNo: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.breakdown.findUnique({
          where: { breakdown_id: breakdownId },
          include: BREAKDOWN_INCLUDE,
        });
        if (!row) throw new NotFoundException('없는 고장 기록입니다.');
        const [links, aggregates] = await Promise.all([
          this.orderLinks(tx, [row.breakdown_id]),
          tx.$queryRaw<DowntimeAggregate[]>(Prisma.sql`
            SELECT count(*)::int AS linked_downtime_count,
                   count(*) FILTER (WHERE ended_at IS NULL)::int
                     AS open_linked_downtime_count,
                   COALESCE(sum(extract(epoch FROM ended_at - started_at))
                     FILTER (WHERE ended_at IS NOT NULL), 0)::numeric AS closed_seconds
            FROM maintenance.equipment_downtime
            WHERE breakdown_id = ${row.breakdown_id}`),
        ]);
        const aggregate = downtimeAggregate(aggregates[0]);
        const orders = orderIdsByBreakdown(links);
        return {
          view: breakdownView(row, singleOrderId(orders.get(row.breakdown_id)), aggregate),
          versionNo: row.version_no,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private orderLinks(tx: Prisma.TransactionClient, ids: bigint[]): Promise<OrderLink[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.$queryRaw<OrderLink[]>(Prisma.sql`
      SELECT o.breakdown_id, o.maintenance_order_id
      FROM maintenance.maintenance_order o
      WHERE o.breakdown_id IN (${Prisma.join(ids)})
      UNION
      SELECT t.source_id AS breakdown_id, t.maintenance_order_id
      FROM maintenance.maintenance_order_trigger t
      WHERE t.trigger_type_code = 'BREAKDOWN'
        AND t.source_id IN (${Prisma.join(ids)})`);
  }
}

function orderIdsByBreakdown(rows: OrderLink[]): Map<bigint, Set<bigint>> {
  const result = new Map<bigint, Set<bigint>>();
  for (const row of rows) {
    const ids = result.get(row.breakdown_id) ?? new Set<bigint>();
    ids.add(row.maintenance_order_id);
    result.set(row.breakdown_id, ids);
  }
  return result;
}

function singleOrderId(ids: Set<bigint> | undefined): number | null {
  return ids?.size === 1 ? Number([...ids][0]) : null;
}

export function downtimeAggregate(row: DowntimeAggregate): BreakdownDetailAggregate {
  const minutes = row.closed_seconds.mod(60).isZero()
    ? row.closed_seconds.dividedBy(60).toNumber()
    : null;
  if (minutes !== null && !Number.isSafeInteger(minutes))
    throw new Error('Breakdown downtime minutes exceed safe integer range');
  return {
    linkedDowntimeCount: row.linked_downtime_count,
    linkedDowntimeMinutes: minutes,
    openLinkedDowntimeCount: row.open_linked_downtime_count,
  };
}
