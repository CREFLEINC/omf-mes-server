import { crossesMidnight } from '../../core/calendar/shift-crossing';

/**
 * W/O 계획 창 — 계획일의 «근무일 하루».
 *
 * 근무일은 그 생산(주간 + 야간)이 시작한 날이다. 그래서 하루는 가장 이른 활성 교대의 시작부터
 * 24시간이고, 자정을 넘긴 야간도 계획일에 든다. 교대가 없는 공장은 08:00 부터다.
 * 교대는 W/O 에 정하지 않는다 — ERP W/O 에도 교대가 없고, 현장이 4M 에서 고른다.
 */
export const DEFAULT_DAY_START = '08:00:00';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanWindow {
  plannedStartAt: Date;
  plannedEndAt: Date;
}

/** `@db.Time(6)` 은 Prisma 가 1970-01-01 UTC 의 `Date` 로 준다 — `HH:MM:SS` 만 떼어 낸다. */
export function timeOfColumn(column: Date): string {
  return column.toISOString().slice(11, 19);
}

/** `timezone` 의 벽시계 날짜·시각을 UTC 순간으로 바꾼다. ⛔ SQL 타임존 캐스팅 금지(CLAUDE.md). */
export function zonedToUtc(date: string, time: string, timezone: string): Date {
  const asIfUtc = new Date(`${date}T${time}.000Z`);
  // 오프셋은 그 순간의 것이다 — 서머타임이 있는 시간대도 한 번 더 맞추면 닫힌다.
  const first = new Date(asIfUtc.getTime() - offsetMs(asIfUtc, timezone));
  return new Date(asIfUtc.getTime() - offsetMs(first, timezone));
}

export function dayWindow(planDate: string, dayStart: string, timezone: string): PlanWindow {
  const plannedStartAt = zonedToUtc(planDate, dayStart, timezone);
  return { plannedStartAt, plannedEndAt: new Date(plannedStartAt.getTime() + DAY_MS) };
}

/** 교대 시각 — `HH:MM:SS`(`timeOfColumn`). */
export interface ShiftTimes {
  startTime: string;
  endTime: string;
}

/**
 * 교대를 정한 W/O 의 창 — 계획일의 그 교대 시작부터 종료까지. 자정을 넘는 교대(`crossesMidnight` — 시각 기준)는 다음 날 끝난다.
 * ⛔ 화면 4M 배정(`assignment-model.ts` 의 `plannedWindowLocal`)과 같은 판정이어야 한다 — 갈리면 확정한 W/O 시각과 4M 화면이 다시 낸 시각이 다르다.
 */
export function shiftWindow(planDate: string, shift: ShiftTimes, timezone: string): PlanWindow {
  return {
    plannedStartAt: zonedToUtc(planDate, shift.startTime, timezone),
    plannedEndAt: zonedToUtc(crossesMidnight(shift.startTime, shift.endTime) ? addDays(planDate, 1) : planDate, shift.endTime, timezone),
  };
}

/** 근무일 시작 — 가장 이른 활성 교대의 시작. 활성 교대가 없으면 08:00. */
export function dayStartOf(activeShiftStarts: readonly string[]): string {
  return [...activeShiftStarts].sort()[0] ?? DEFAULT_DAY_START;
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** 그 순간 `timezone` 의 벽시계 날짜(`YYYY-MM-DD`). */
export function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** 그 순간 `timezone` 의 벽시계가 UTC 보다 몇 ms 앞서는가. */
function offsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((entry) => entry.type === type)?.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}
