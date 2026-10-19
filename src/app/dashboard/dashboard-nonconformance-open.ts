import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { OPEN_NC_WHERE, SCOPED_NC_CTE } from './dashboard-quality-status';
import { DashboardPeriod, coarseRange, localDate, plantScope } from './dashboard-scope';
import { OpenNonconformance, RepeatedItem } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

export const OPEN_LIST_LIMIT = 5;
export const REPEATED_ITEM_LIMIT = 5;

interface OpenRow {
  nonconformance_id: bigint;
  nonconformance_no: string;
  item_code: string | null;
  item_name: string | null;
  severity_code: string;
  severity_name: string | null;
  status_code: string;
  status_name: string | null;
  opened_at: Date;
}

/** `openCount` 와 같은 모집단(공장 범위 `scoped_nc` · `OPEN_NC_WHERE`) — 발생(`opened_at`) 오래된 순 → id, 상위 5. */
export function openNonconformanceSql(plants: readonly DashboardPlant[], limit: number | null): Prisma.Sql {
  return Prisma.sql`WITH ${plantScope(plants)}, ${SCOPED_NC_CTE}
    SELECT nc.nonconformance_id, nc.nonconformance_no, i.item_code, i.item_name,
      nc.severity_code, sev.code_name AS severity_name, nc.status_code, st.code_name AS status_name, nc.opened_at
    FROM scoped_nc nc
    LEFT JOIN mdm.item i ON i.item_id = nc.item_id
    LEFT JOIN ${codeName('NONCONFORMANCE_SEVERITY')} sev ON sev.code = nc.severity_code
    LEFT JOIN ${codeName('NONCONFORMANCE_STATUS')} st ON st.code = nc.status_code
    WHERE ${OPEN_NC_WHERE}
    ORDER BY nc.opened_at, nc.nonconformance_id
    ${limit === null ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}`;
}

export async function readOpenNonconformances(
  tx: Tx,
  plants: readonly DashboardPlant[],
): Promise<OpenNonconformance[]> {
  if (plants.length === 0) return [];
  const rows = await tx.$queryRaw<OpenRow[]>(openNonconformanceSql(plants, OPEN_LIST_LIMIT));
  return rows.map(openNonconformance);
}

export function openNonconformance(row: OpenRow): OpenNonconformance {
  return {
    nonconformanceId: Number(row.nonconformance_id),
    nonconformanceNo: row.nonconformance_no,
    itemCode: row.item_code,
    itemName: row.item_name,
    severityCode: row.severity_code,
    severityName: row.severity_name,
    statusCode: row.status_code,
    statusName: row.status_name,
    openedAt: row.opened_at.toISOString(),
  };
}

interface RepeatedRow {
  item_id: bigint;
  item_code: string;
  item_name: string;
  nc_count: number;
  last_opened_at: Date;
  total_items: number;
}

/**
 * 반복 부적합 품목 — 누계 구간(`monthQty` 와 같은 공장 범위 `scoped_nc` · `opened_at` 의 부적합 공장 현지 날짜)에 부적합이 2건 이상인 품목.
 * 불량현상은 보지 않는다. 건수 내림차순 → 최근 발생 내림차순 → item_id, 상위 5. `total_items` = 조건에 드는 품목 전체 수.
 */
export async function readRepeatedItems(
  tx: Tx,
  plants: readonly DashboardPlant[],
  period: DashboardPeriod,
): Promise<{ repeatedItems: RepeatedItem[]; repeatedItemCount: number }> {
  if (plants.length === 0) return { repeatedItems: [], repeatedItemCount: 0 };
  const rows = await tx.$queryRaw<RepeatedRow[]>(Prisma.sql`WITH ${plantScope(plants)}, ${SCOPED_NC_CTE},
    repeated AS (
      SELECT nc.item_id, COUNT(*)::int AS nc_count, MAX(nc.opened_at) AS last_opened_at
      FROM scoped_nc nc
      WHERE ${coarseRange(Prisma.sql`nc.opened_at`, period.from, period.to)}
        AND ${localDate(Prisma.sql`nc.opened_at`, Prisma.sql`nc.tz`)} BETWEEN ${period.from}::date AND ${period.to}::date
        AND nc.item_id IS NOT NULL
      GROUP BY nc.item_id HAVING COUNT(*) >= 2
    )
    SELECT r.item_id, i.item_code, i.item_name, r.nc_count, r.last_opened_at, (COUNT(*) OVER ())::int AS total_items
    FROM repeated r JOIN mdm.item i ON i.item_id = r.item_id
    ORDER BY r.nc_count DESC, r.last_opened_at DESC, r.item_id
    LIMIT ${REPEATED_ITEM_LIMIT}`);
  return { repeatedItems: rows.map(repeatedItem), repeatedItemCount: rows[0]?.total_items ?? 0 };
}

export function repeatedItem(row: Omit<RepeatedRow, 'total_items'>): RepeatedItem {
  return {
    itemId: Number(row.item_id),
    itemCode: row.item_code,
    itemName: row.item_name,
    ncCount: row.nc_count,
    lastOpenedAt: row.last_opened_at.toISOString(),
  };
}

function codeName(groupCode: string): Prisma.Sql {
  return Prisma.sql`(SELECT cv.code, cv.code_name FROM mdm.code_value cv
    JOIN mdm.code_group cg ON cg.code_group_id = cv.code_group_id WHERE cg.group_code = ${groupCode})`;
}
