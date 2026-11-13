import { isWorkingDay } from './issue-work-date';

/**
 * 근무일 판정 — 계약 `PlanningCalendarDay`. 생산계획의 날짜 판단(조회 API·제안 보정·휴일 경고)이 이 한 벌을 쓴다.
 * 캘린더 선택은 설비 가동 정지 요약과 같은 SQL(`working-day-resolver.ts`)이 하고, 여기는 고른 캘린더의 그 날과 공장 근무일 정책으로 판정만 한다.
 */

export type DayStatus = 'WORKING' | 'HOLIDAY' | 'PARTIAL' | 'UNDETERMINED';
export type DaySource = 'LINE_CALENDAR' | 'PARENT_LINE_CALENDAR' | 'PLANT_CALENDAR' | 'WEEKLY_POLICY' | 'NOT_CONFIGURED';

export interface PlanningCalendarDay {
  date: string;
  statusCode: DayStatus;
  sourceCode: DaySource;
  workCalendarId: number | null;
  calendarCode: string | null;
  appliedProductionLineId: number | null;
  reasonCode: string | null;
  remarks: string | null;
  startTime: string | null;
  endTime: string | null;
  weeklyWorkingDays: 5 | 6 | null;
}

/** 한 날짜에 고른 캘린더와 그 날 — 고른 캘린더가 없으면 `workCalendarId` 가 null 이다. */
export interface CalendarDayFact {
  date: string;
  workCalendarId: bigint | null;
  calendarCode: string | null;
  calendarActive: boolean | null;
  /** 적용을 찾은 층 — 0 그 라인, 1 이상 상위 라인, null 공장. */
  lineDepth: number | null;
  appliedLineId: bigint | null;
  dayTypeCode: string | null;
  startTime: string | null;
  endTime: string | null;
  reasonCode: string | null;
  remarks: string | null;
}

/** 제안 계획일 보정이 원래 날짜 다음 날부터 보는 날 수. */
export const PLAN_DATE_SEARCH_LIMIT_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** 양 끝을 포함한 날 수. */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / DAY_MS) + 1;
}

/**
 * 고른 캘린더가 사용 중이고 그 날을 유효하게 등록했으면 그 판정, 아니면 그날 유효한 공장 근무일 정책의 요일, 정책도 없으면 판정 불가.
 * ⛔ 캘린더에 날짜가 없어도 상위 층 캘린더로 내려가지 않는다 — 설비 가동 정지 요약과 같은 규칙이다.
 * ⛔ 정책이 없는 공장에 주 5일 기본값을 쓰지 않는다(`weekly` 가 null 이면 판정 불가).
 */
export function judgeDay(fact: CalendarDayFact, weekly: 5 | 6 | null): PlanningCalendarDay {
  const base = {
    date: fact.date,
    workCalendarId: fact.workCalendarId === null ? null : Number(fact.workCalendarId),
    calendarCode: fact.calendarCode,
    appliedProductionLineId: fact.lineDepth === null || fact.appliedLineId === null ? null : Number(fact.appliedLineId),
  };
  const empty = { reasonCode: null, remarks: null, startTime: null, endTime: null };
  if (usableDay(fact)) {
    const status = fact.dayTypeCode as 'WORKING' | 'HOLIDAY' | 'PARTIAL';
    return {
      ...base,
      statusCode: status,
      sourceCode: fact.lineDepth === null ? 'PLANT_CALENDAR' : fact.lineDepth === 0 ? 'LINE_CALENDAR' : 'PARENT_LINE_CALENDAR',
      reasonCode: fact.reasonCode,
      remarks: fact.remarks,
      startTime: status === 'PARTIAL' ? fact.startTime : null,
      endTime: status === 'PARTIAL' ? fact.endTime : null,
      weeklyWorkingDays: null,
    };
  }
  if (weekly === null) return { ...base, ...empty, statusCode: 'UNDETERMINED', sourceCode: 'NOT_CONFIGURED', weeklyWorkingDays: null };
  const working = isWorkingDay(new Date(`${fact.date}T00:00:00.000Z`), weekly);
  return { ...base, ...empty, statusCode: working ? 'WORKING' : 'HOLIDAY', sourceCode: 'WEEKLY_POLICY', weeklyWorkingDays: weekly };
}

/** 부분 가동은 시각이 서야 쓴다 — 요약도 시각이 없거나 거꾸로면 그 날을 쓰지 않는다. */
function usableDay(fact: CalendarDayFact): boolean {
  if (fact.workCalendarId === null || fact.calendarActive !== true) return false;
  if (fact.dayTypeCode === 'WORKING' || fact.dayTypeCode === 'HOLIDAY') return true;
  return fact.dayTypeCode === 'PARTIAL' && fact.startTime !== null && fact.endTime !== null && fact.endTime > fact.startTime;
}

export type AdjustmentOutcome = 'NOT_NEEDED' | 'ADJUSTED' | 'NOT_ADJUSTED_UNDETERMINED' | 'NOT_ADJUSTED_SEARCH_LIMIT' | 'USER_SPECIFIED';

export interface PlanDateAdjustment {
  originalDate: string;
  adjustedDate: string | null;
  outcomeCode: AdjustmentOutcome;
  searchLimitDays: number;
  skippedDays: PlanningCalendarDay[];
}

export interface AdjustedPlanDate {
  planDate: string;
  day: PlanningCalendarDay;
  adjustment: PlanDateAdjustment;
  /** 보정 판단에 쓴 날 — 원래 날짜부터 고른 날까지(한도에 걸리면 한도까지). 제안 basis 가 이것만 본다. */
  usedDays: PlanningCalendarDay[];
}

/**
 * 시스템이 정한 날짜의 보정. HOLIDAY 만 건너뛰고 휴일이 아닌 첫날로 옮긴다 — UNDETERMINED 도 그 날로 옮긴다(경고는 판정이 낸다).
 * 원래 날짜가 판정 불가면 옮기지 않는다. `days` 는 원래 날짜부터 한도까지 날짜 순이어야 한다.
 */
export function adjustPlanDate(days: readonly PlanningCalendarDay[]): AdjustedPlanDate {
  const [first] = days;
  const result = (outcome: AdjustmentOutcome, day: PlanningCalendarDay, used: PlanningCalendarDay[]): AdjustedPlanDate => ({
    planDate: day.date,
    day,
    adjustment: {
      originalDate: first.date,
      adjustedDate: outcome === 'ADJUSTED' ? day.date : null,
      outcomeCode: outcome,
      searchLimitDays: PLAN_DATE_SEARCH_LIMIT_DAYS,
      skippedDays: outcome === 'ADJUSTED' || outcome === 'NOT_ADJUSTED_SEARCH_LIMIT' ? used.filter((item) => item.statusCode === 'HOLIDAY') : [],
    },
    usedDays: used,
  });
  if (first.statusCode === 'UNDETERMINED') return result('NOT_ADJUSTED_UNDETERMINED', first, [first]);
  if (first.statusCode !== 'HOLIDAY') return result('NOT_NEEDED', first, [first]);
  const found = days.findIndex((day, index) => index > 0 && index <= PLAN_DATE_SEARCH_LIMIT_DAYS && day.statusCode !== 'HOLIDAY');
  if (found < 0) return result('NOT_ADJUSTED_SEARCH_LIMIT', first, days.slice(0, PLAN_DATE_SEARCH_LIMIT_DAYS + 1));
  return result('ADJUSTED', days[found], days.slice(0, found + 1));
}

/** 사용자가 고른 날짜 — 보정하지 않고 판정만 싣는다. */
export function keepUserDate(day: PlanningCalendarDay): AdjustedPlanDate {
  return {
    planDate: day.date,
    day,
    adjustment: { originalDate: day.date, adjustedDate: null, outcomeCode: 'USER_SPECIFIED', searchLimitDays: PLAN_DATE_SEARCH_LIMIT_DAYS, skippedDays: [] },
    usedDays: [],
  };
}
