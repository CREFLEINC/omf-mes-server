const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface MaintenanceDateRange {
  readonly gte?: Date;
  readonly lt?: Date;
}

type DayBounds = { start: number; end: number };

function calendarDay(value: string): number {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid maintenance calendar date: ${value}`);
  }
  return date.getTime();
}

function nextCalendarDay(day: number): number {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

function localWallTime(at: number, formatter: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map(({ type, value }) => [type, value]),
  );
  const year = Number(parts.year);
  const hour = Number(parts.hour);
  if ((parts.era !== 'AD' && parts.era !== 'BC') || hour < 0 || hour > 23) {
    throw new Error('Cannot resolve maintenance calendar clock fields');
  }
  // Date.UTC treats years 0..99 as 1900..1999; Gregorian BC 1 is ISO year 0.
  const local = new Date(0);
  local.setUTCFullYear(
    parts.era === 'BC' ? 1 - year : year,
    Number(parts.month) - 1,
    Number(parts.day),
  );
  local.setUTCHours(hour, Number(parts.minute), Number(parts.second), 0);
  if (!Number.isFinite(local.getTime()))
    throw new Error('Invalid maintenance calendar clock fields');
  return local.getTime();
}

function dayBounds(day: number, formatter: Intl.DateTimeFormat): DayBounds {
  const next = nextCalendarDay(day);
  const windowStart = day - 2 * DAY_MS;
  const windowEnd = next + 2 * DAY_MS;
  const offsetAt = (at: number): number => {
    const offset = localWallTime(at, formatter) - at;
    if (Math.abs(offset) > DAY_MS) throw new Error('Unsupported maintenance calendar offset');
    return offset;
  };
  let bounds: DayBounds | undefined;
  const include = (start: number, end: number, offset: number): void => {
    const first = Math.max(start, day - offset);
    const last = Math.min(end, next - offset);
    if (first >= last) return;
    if (bounds && first !== bounds.end) {
      throw new Error('Maintenance calendar date is not one continuous UTC interval');
    }
    bounds = { start: bounds?.start ?? first, end: last };
  };

  // Intl exposes offsets, not transitions. This scan supports IANA days whose
  // transitions are at least one hour apart, with second precision and |offset| <= 24h.
  // I-30 review audited Node 25.6.0 / ICU 78.2 / tzdb 2025c: 638 zones, years
  // 0000..9999 plus the scan margins; the minimum transition gap was 597600 seconds.
  // That is measured data, not a guarantee for other/future tzdb versions; re-audit
  // on runtime data changes. Hourly samples cannot detect two cancelling changes
  // inside one hour, so such data remains outside this solver's scope.
  let segmentStart = windowStart;
  let offset = offsetAt(windowStart);
  for (let at = windowStart + HOUR_MS; at <= windowEnd; at += HOUR_MS) {
    const nextOffset = offsetAt(at);
    if (nextOffset === offset) continue;
    let low = at - HOUR_MS;
    let high = at;
    while (high - low > 1000) {
      const middle = Math.floor((low + high) / 2000) * 1000;
      if (offsetAt(middle) === offset) low = middle;
      else high = middle;
    }
    if (offsetAt(high) !== nextOffset) {
      throw new Error('Cannot resolve maintenance calendar transition');
    }
    include(segmentStart, high, offset);
    segmentStart = high;
    offset = nextOffset;
  }
  include(segmentStart, windowEnd, offset);
  if (!bounds) throw new Error('Maintenance calendar date does not exist in this timezone');
  const { start, end } = bounds;
  const localStart = localWallTime(start, formatter);
  const localLast = localWallTime(end - 1000, formatter);
  if (
    localStart < day ||
    localStart >= next ||
    localLast < day ||
    localLast >= next ||
    localWallTime(start - 1000, formatter) >= day ||
    localWallTime(end, formatter) < next
  ) {
    throw new Error('Cannot verify maintenance calendar date boundaries');
  }
  return bounds;
}

/**
 * 공장 date 양끝 포함 → UTC timestamp [gte, lt). 입력 날짜는 저장 시각이 아니다.
 * YYYY-MM-DD(0000..9999년)를 받으며 시간대 데이터는 dayBounds의 탐색 전제를 따른다.
 * 존재하는 연속일은 첫 유효 순간을 쓰며, 자정 반복은 더 이른 순간부터 포함한다.
 * 잘못된 date/zone·없는 날·비연속일·확정 불가 경계는 Error → 기존 INTERNAL_ERROR다.
 * 없는 끝은 생략하고 역전은 그대로 둔다. 기간 필수/역전 빈집합 처리는 호출자 소관이다.
 */
export function maintenanceDateRange(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  timezone: string,
): MaintenanceDateRange {
  if (dateFrom === undefined && dateTo === undefined) return {};
  if (!timezone) throw new Error('Maintenance calendar timezone is required');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const resolved = new Map<number, DayBounds>();
  const resolve = (day: number): DayBounds => {
    const bounds = resolved.get(day) ?? dayBounds(day, formatter);
    resolved.set(day, bounds);
    return bounds;
  };
  const gte = dateFrom === undefined ? undefined : new Date(resolve(calendarDay(dateFrom)).start);
  let lt: Date | undefined;
  if (dateTo !== undefined) {
    const to = calendarDay(dateTo);
    resolve(to); // To 자체가 없는 날이어도 익일로 조용히 보정하지 않는다.
    lt = new Date(resolve(nextCalendarDay(to)).start);
  }
  return { ...(gte === undefined ? {} : { gte }), ...(lt === undefined ? {} : { lt }) };
}
