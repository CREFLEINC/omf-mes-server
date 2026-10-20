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
