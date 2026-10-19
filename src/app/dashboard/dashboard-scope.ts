import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { trailingDays } from './dashboard-view';

/** 기준일·당월·전월 — 공장 현지 달력 날짜(YYYY-MM-DD). 당월은 1일~기준일이다. */
export interface DashboardPeriod {
  readonly baseDate: string;
  readonly monthStart: string;
  readonly previousMonthStart: string;
  readonly previousMonthEnd: string;
}

export function dashboardPeriod(baseDate: string): DashboardPeriod {
  const monthStart = `${baseDate.slice(0, 8)}01`;
  const [previousMonthEnd] = trailingDays(monthStart, 2);
  return { baseDate, monthStart, previousMonthStart: `${previousMonthEnd.slice(0, 8)}01`, previousMonthEnd };
}

/**
 * `plant_scope(plant_id, tz)` CTE 본문 — 공장마다 자기 시간대로 현지 날짜를 푼다.
 * ⚠ 공장이 하나 이상일 때만 부른다(빈 VALUES 는 SQL 오류다).
 */
export function plantScope(plants: readonly DashboardPlant[]): Prisma.Sql {
  return Prisma.sql`plant_scope(plant_id, tz) AS (VALUES ${Prisma.join(
    plants.map((plant) => Prisma.sql`(${plant.plantId}::bigint, ${plant.timezone}::text)`),
  )})`;
}

/** 시각 칸의 공장 현지 날짜. 시간대 칸은 기본이 `plant_scope` 별칭 `ps` 의 `tz` 다. */
export function localDate(column: Prisma.Sql, timezone: Prisma.Sql = Prisma.sql`ps.tz`): Prisma.Sql {
  return Prisma.sql`(${column} AT TIME ZONE ${timezone})::date`;
}

/**
 * 인덱스를 타게 하는 거친 UTC 경계 — 현지 날짜 비교 앞에 함께 건다.
 * 시간대 차(±14h)를 넉넉히 덮도록 앞뒤로 하루씩 넓힌다.
 */
export function coarseRange(column: Prisma.Sql, from: string, to: string): Prisma.Sql {
  return Prisma.sql`${column} >= ${from}::date - INTERVAL '1 day' AND ${column} < ${to}::date + INTERVAL '2 day'`;
}

export function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
