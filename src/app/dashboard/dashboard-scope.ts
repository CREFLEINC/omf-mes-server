import { Prisma } from '@prisma/client';

import { maintenanceDateRange } from '../../maintenance/maintenance-calendar';

import type { DashboardPlant } from './dashboard-availability.service';
import { DashboardRange, DashboardRangeQuery, dashboardRange, previousRange, shiftDate } from './dashboard-range';
import { chartDays } from './dashboard-view';

/**
 * 품질·부적합의 누계 구간 — 공장 현지 달력 날짜(YYYY-MM-DD). 응답 칸 이름은 「당월·전월·금일」 그대로다.
 * - 하루 조회: 누계 = 당월 1일~기준일, 비교 = 전월(#118 기간 조회 결정 B — 기본 화면 유지).
 * - 이틀 이상: 누계 = 조회 기간, 비교 = 바로 앞 같은 길이 기간.
 */
export interface DashboardPeriod {
  readonly from: string;
  /** 언제나 조회 종료일이다. */
  readonly to: string;
  readonly previousFrom: string;
  readonly previousTo: string;
  /** 「금일」 칸 = 조회 기간. */
  readonly range: DashboardRange;
  /** 일별 차트 날짜 — 생산 추이와 같은 규칙. */
  readonly chartDays: readonly string[];
}

export function dashboardPeriod(range: DashboardRange): DashboardPeriod {
  const chart = chartDays(range);
  if (range.from !== range.to) {
    const previous = previousRange(range);
    return { from: range.from, to: range.to, previousFrom: previous.from, previousTo: previous.to, range, chartDays: chart };
  }
  const monthStart = `${range.to.slice(0, 8)}01`;
  const previousTo = shiftDate(monthStart, -1);
  return {
    from: monthStart,
    to: range.to,
    previousFrom: `${previousTo.slice(0, 8)}01`,
    previousTo,
    range,
    chartDays: chart,
  };
}

/** 이 구간의 가장 이른 날 — 거친 UTC 경계를 거는 데 쓴다. */
export function periodStart(period: DashboardPeriod): string {
  return [period.previousFrom, period.chartDays[0], period.range.from].sort()[0];
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

/** 그 시간대의 오늘(YYYY-MM-DD). */
export function localToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}

/** 공장을 고르지 않았을 때 「오늘」을 정하는 시간대 — 현장이 하노이 한 곳이다. */
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

export interface DashboardScopeQuery extends DashboardRangeQuery {
  plantId?: number | bigint;
}

/**
 * 공장·조회 기간·누계 구간 — 대시보드와 상태별 LOT 목록이 같은 규칙으로 푼다.
 * 기간 검증 오류(400)도 여기서 난다.
 */
export async function dashboardScope(tx: Prisma.TransactionClient, query: DashboardScopeQuery, now: Date) {
  const plantRows = await tx.plant.findMany({
    where: query.plantId === undefined ? { is_active: true } : { plant_id: BigInt(query.plantId) },
    select: { plant_id: true, timezone_code: true },
    orderBy: { plant_id: 'asc' },
  });
  const today = localToday(now, plantRows.length === 1 && query.plantId !== undefined
    ? plantRows[0].timezone_code
    : DEFAULT_TIMEZONE);
  const range = dashboardRange(query, today);
  return {
    plantRows,
    range,
    period: dashboardPeriod(range),
    plants: plantRows.map((row) => dashboardPlant(row.plant_id, row.timezone_code, range, now.getTime())),
  };
}

export function dashboardPlant(plantId: bigint, timezone: string, range: DashboardRange, now: number): DashboardPlant {
  const span = localSpan(range.from, range.to, timezone);
  return {
    plantId,
    timezone,
    range: span,
    day: localSpan(range.to, range.to, timezone),
    measured: { start: span.start, end: Math.max(span.start, Math.min(span.end, now)) },
  };
}

function localSpan(from: string, to: string, timezone: string): { start: number; end: number } {
  const range = maintenanceDateRange(from, to, timezone);
  if (range.gte === undefined || range.lt === undefined) throw new Error('Cannot resolve dashboard day');
  return { start: range.gte.getTime(), end: range.lt.getTime() };
}
