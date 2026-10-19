import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { DashboardRange, previousRange, shiftDate } from './dashboard-range';
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

/**
 * 출하요청의 공장 — `fulfillment_plant_id`, 비었으면 그 요청을 처음 출하한 창고의 공장. 둘 다 없으면 null(공장 미지정).
 * 출하 대기·다음 출하·납기 경과·OQC 가 이 한 식으로 공장을 가른다(사용자 결정 2026-10-19). `request` = 출하요청 별칭.
 */
export function requestPlant(request: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(${request}.fulfillment_plant_id, (
    SELECT w.plant_id FROM logistics.shipment s
    JOIN mdm.warehouse w ON w.warehouse_id = s.warehouse_id
    WHERE s.shipment_request_id = ${request}.shipment_request_id
    ORDER BY s.shipment_id LIMIT 1))`;
}

/**
 * 공장 범위의 출하요청 — 공장이 정해진 요청은 그 공장일 때만, 공장 미지정 요청은 어느 공장을 골라도 넣는다
 * (「공장이 지정되지 않은 출하 요청이면 공장에 상관없이 동작이 가능해야 한다」). ⚠ 앞에 `plant_scope` CTE 가 있어야 한다.
 */
export function requestInScope(request: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${requestPlant(request)} IS NULL OR ${requestPlant(request)} IN (SELECT plant_id FROM plant_scope))`;
}

export function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** 그 시간대의 오늘(YYYY-MM-DD). */
export function localToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
}
