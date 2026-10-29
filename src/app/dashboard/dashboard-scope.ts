import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
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

/** 공장을 고르지 않았을 때 「오늘」을 정하는 시간대 — 현장이 하노이 한 곳이다. */
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

export interface DashboardScopeQuery extends DashboardRangeQuery {
  plantId?: number | bigint;
}

/**
 * 사용자 데이터 범위(`app.user_data_scope`)가 허락하는 공장 조건(omf-all-around#120 · 장부 P-62).
 * 줄마다 가장 좁은 축 하나로 본다 — 공장 > 사업부 > 법인. 줄이 없으면 null(제한 없음 — 사용자 결정 2026-10-19).
 * ⚠ 세션의 `scopes` 가 아니라 DB 를 읽는다 — 세션은 사업부가 빈 줄(공장만 지정)을 버리고, 로그인 뒤 바뀐 범위를 모른다.
 */
export async function scopedPlantWhere(tx: Prisma.TransactionClient, actorUserId: number): Promise<Prisma.plantWhereInput | null> {
  const rows = await tx.user_data_scope.findMany({
    where: { app_user_id: BigInt(actorUserId) },
    select: { legal_entity_id: true, business_unit_id: true, plant_id: true },
  });
  if (rows.length === 0) return null;
  return {
    OR: rows.map((row) =>
      row.plant_id !== null
        ? { plant_id: row.plant_id }
        : row.business_unit_id !== null
          ? { business_unit_id: row.business_unit_id }
          : { legal_entity_id: row.legal_entity_id ?? BigInt(0) },
    ),
  };
}

function plantDenied(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [
    field('plantId', ERROR_CODE.PERMISSION_DENIED, '이 공장에 대한 데이터 권한이 없습니다.'),
  ]);
}

/**
 * 공장·조회 기간·누계 구간 — 대시보드와 상태별 LOT 목록이 같은 규칙으로 푼다.
 * 기간 검증 오류(400)와 데이터 범위 밖 공장 거절(403)도 여기서 난다.
 * 공장을 고르면 범위 안이어야 하고, 고르지 않으면(전체) 범위 안의 활성 공장만 합산한다.
 */
export async function dashboardScope(
  tx: Prisma.TransactionClient,
  query: DashboardScopeQuery,
  now: Date,
  actorUserId: number,
) {
  const scoped = await scopedPlantWhere(tx, actorUserId);
  const base: Prisma.plantWhereInput =
    query.plantId === undefined ? { is_active: true } : { plant_id: BigInt(query.plantId) };
  const plantRows = await tx.plant.findMany({
    where: scoped === null ? base : { AND: [base, scoped] },
    select: { plant_id: true, timezone_code: true },
    orderBy: { plant_id: 'asc' },
  });
  /* 범위가 있는데 남는 공장이 없다 — 고른 공장이 범위 밖이거나, 범위의 공장이 모두 비활성이다. */
  if (scoped !== null && plantRows.length === 0) throw plantDenied();
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
