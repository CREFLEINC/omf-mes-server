import { Prisma } from '@prisma/client';

import { lineAncestors, selectedCalendar } from '../../core/calendar/calendar-selection';
import { CalendarDayFact, PlanningCalendarDay, judgeDay } from '../../core/calendar/working-day';
import { WEEKLY_WORKING_DAYS, WeeklyWorkingDays, winnerOf } from './operation-policy-rules';
import { DEFAULT_WEEKLY_WORKING_DAYS } from './working-days';

/** 공장 현지 날짜(YYYY-MM-DD) 구간 하나. 라인이 null 이면 공장 층만 본다. */
export interface WorkingDayTarget {
  plantId: bigint;
  lineId: bigint | null;
  from: string;
  to: string;
}

type DayRow = {
  scope_key: number;
  calendar_date: string;
  work_calendar_id: bigint | null;
  line_depth: number | null;
  applied_line_id: bigint | null;
  calendar_code: string | null;
  calendar_active: boolean | null;
  day_type_code: string | null;
  start_time: string | null;
  end_time: string | null;
  reason_code: string | null;
  remarks: string | null;
};

/** 구간마다 날짜별 판정 — 입력 순서·같은 수로, 날짜는 from 부터 to 까지 빠짐없이. */
export async function resolveWorkingDays(tx: Prisma.TransactionClient, targets: readonly WorkingDayTarget[]): Promise<PlanningCalendarDay[][]> {
  if (targets.length === 0) return [];
  const values = targets.map((target, index) => Prisma.sql`(${index}::int,${target.plantId}::bigint,${target.lineId}::bigint,${target.from}::date,${target.to}::date)`);
  const rows = await tx.$queryRaw<DayRow[]>(Prisma.sql`
      WITH RECURSIVE scoped(scope_key,plant_id,line_id,date_from,date_to) AS
        (VALUES ${Prisma.join(values)}),
      ${lineAncestors('scoped', 'scope_key')},
      date_scope AS (
        SELECT source.scope_key,source.plant_id,day::date AS calendar_date
        FROM scoped source
        CROSS JOIN LATERAL generate_series(source.date_from,source.date_to,INTERVAL '1 day') day
      )
      SELECT scope.scope_key,to_char(scope.calendar_date,'YYYY-MM-DD') calendar_date,
        selected.work_calendar_id,selected.line_depth,selected.applied_line_id,
        calendar.calendar_code,calendar.is_active AS calendar_active,day.day_type_code,
        to_char(day.work_start_time,'HH24:MI:SS') start_time,
        to_char(day.work_end_time,'HH24:MI:SS') end_time,
        day.reason_code,day.remarks
      FROM date_scope scope
      ${selectedCalendar('scope_key')}
      LEFT JOIN mdm.work_calendar calendar
        ON calendar.work_calendar_id=selected.work_calendar_id
      LEFT JOIN mdm.work_calendar_day day
        ON day.work_calendar_id=selected.work_calendar_id
        AND day.calendar_date=scope.calendar_date
      ORDER BY scope.scope_key,scope.calendar_date`);
  const weekly = await weeklyPolicyOf(tx, targets);
  const result: PlanningCalendarDay[][] = targets.map(() => []);
  for (const row of rows) {
    const plantId = targets[row.scope_key].plantId;
    result[row.scope_key].push(judgeDay(factOf(row), weekly(plantId, row.calendar_date)));
  }
  return result;
}

function factOf(row: DayRow): CalendarDayFact {
  return {
    date: row.calendar_date,
    workCalendarId: row.work_calendar_id,
    calendarCode: row.calendar_code,
    calendarActive: row.calendar_active,
    lineDepth: row.line_depth,
    appliedLineId: row.applied_line_id,
    dayTypeCode: row.day_type_code,
    startTime: row.start_time,
    endTime: row.end_time,
    reasonCode: row.reason_code,
    remarks: row.remarks,
  };
}

/**
 * 판정하는 날짜마다 그날 유효한 공장 근무일 정책 — `weeklyWorkingDays()` 와 같은 후보·우선순위. 맞는 정책이 없으면 null 이다.
 * ⛔ 없을 때 기본 5 를 쓰지 않는다 — 기본값은 정책이 있는데 값이 5·6 이 아닐 때만 쓴다.
 */
async function weeklyPolicyOf(
  tx: Prisma.TransactionClient,
  targets: readonly WorkingDayTarget[],
): Promise<(plantId: bigint, date: string) => WeeklyWorkingDays | null> {
  const from = targets.reduce((min, target) => (target.from < min ? target.from : min), targets[0].from);
  const to = targets.reduce((max, target) => (target.to > max ? target.to : max), targets[0].to);
  const plantIds = [...new Set(targets.map((target) => target.plantId))];
  const rows = await tx.operation_policy.findMany({
    where: {
      policy_code: 'WEEKLY_WORKING_DAYS',
      item_id: null,
      process_id: null,
      business_unit_id: null,
      OR: [{ plant_id: null }, { plant_id: { in: plantIds } }],
      effective_from: { lte: new Date(`${to}T00:00:00.000Z`) },
      AND: [{ OR: [{ effective_to: null }, { effective_to: { gte: new Date(`${from}T00:00:00.000Z`) } }] }],
    },
  });
  return (plantId, date) => {
    const on = new Date(`${date}T00:00:00.000Z`).getTime();
    const winner = winnerOf(rows.filter((row) =>
      (row.plant_id === null || row.plant_id === plantId)
      && row.effective_from.getTime() <= on
      && (row.effective_to === null || row.effective_to.getTime() >= on)));
    if (winner === undefined) return null;
    const value = Number(winner.value_numeric);
    return (WEEKLY_WORKING_DAYS as readonly number[]).includes(value) ? (value as WeeklyWorkingDays) : DEFAULT_WEEKLY_WORKING_DAYS;
  };
}
