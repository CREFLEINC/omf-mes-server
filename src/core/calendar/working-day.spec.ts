import { CalendarDayFact, PLAN_DATE_SEARCH_LIMIT_DAYS, PlanningCalendarDay, addDays, adjustPlanDate, daysBetween, judgeDay } from './working-day';

const fact = (date: string, extra: Partial<CalendarDayFact> = {}): CalendarDayFact => ({
  date,
  workCalendarId: null,
  calendarCode: null,
  calendarActive: null,
  lineDepth: null,
  appliedLineId: null,
  dayTypeCode: null,
  startTime: null,
  endTime: null,
  reasonCode: null,
  remarks: null,
  ...extra,
});
const calendarDay = (date: string, dayTypeCode: string, extra: Partial<CalendarDayFact> = {}) =>
  fact(date, { workCalendarId: 1n, calendarCode: 'C', calendarActive: true, dayTypeCode, ...extra });
const day = (date: string, statusCode: PlanningCalendarDay['statusCode']): PlanningCalendarDay => ({
  ...judgeDay(fact(date), null),
  statusCode,
});

describe('judgeDay', () => {
  it('캘린더 날짜는 정책과 관계없이 쓴다 — 출처는 적용을 찾은 층', () => {
    expect(judgeDay(calendarDay('2027-03-06', 'WORKING'), 5)).toMatchObject({ statusCode: 'WORKING', sourceCode: 'PLANT_CALENDAR' });
    expect(judgeDay(calendarDay('2027-03-02', 'HOLIDAY', { lineDepth: 0, appliedLineId: 7n }), null)).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'LINE_CALENDAR', appliedProductionLineId: 7 });
    expect(judgeDay(calendarDay('2027-03-02', 'HOLIDAY', { lineDepth: 2, appliedLineId: 3n }), null)).toMatchObject({ sourceCode: 'PARENT_LINE_CALENDAR', appliedProductionLineId: 3 });
  });

  it('부분 가동은 시각이 서야 쓴다 — 아니면 정책으로 본다', () => {
    expect(judgeDay(calendarDay('2027-03-03', 'PARTIAL', { startTime: '08:00:00', endTime: '12:00:00' }), 5)).toMatchObject({ statusCode: 'PARTIAL', startTime: '08:00:00', endTime: '12:00:00' });
    expect(judgeDay(calendarDay('2027-03-03', 'PARTIAL', { startTime: '12:00:00', endTime: '08:00:00' }), 5)).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY' });
  });

  it('사용 중지 캘린더·날짜 없음은 정책, 정책도 없으면 판정 불가 — 주 5일 기본값을 쓰지 않는다', () => {
    expect(judgeDay(calendarDay('2027-03-01', 'HOLIDAY', { calendarActive: false }), 5)).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY', workCalendarId: 1 });
    expect(judgeDay(fact('2027-03-06'), 5)).toMatchObject({ statusCode: 'HOLIDAY', weeklyWorkingDays: 5 });
    expect(judgeDay(fact('2027-03-06'), 6)).toMatchObject({ statusCode: 'WORKING', weeklyWorkingDays: 6 });
    expect(judgeDay(fact('2027-03-07'), 6)).toMatchObject({ statusCode: 'HOLIDAY' });
    expect(judgeDay(fact('2027-03-07'), null)).toMatchObject({ statusCode: 'UNDETERMINED', sourceCode: 'NOT_CONFIGURED', weeklyWorkingDays: null });
  });
});

describe('adjustPlanDate', () => {
  const run = (statuses: PlanningCalendarDay['statusCode'][]) =>
    adjustPlanDate(statuses.map((status, index) => day(addDays('2027-03-01', index), status)));

  it('휴일이 아니면 그대로, 판정 불가면 보정하지 않는다', () => {
    expect(run(['WORKING'])).toMatchObject({ planDate: '2027-03-01', adjustment: { outcomeCode: 'NOT_NEEDED', adjustedDate: null, skippedDays: [] } });
    expect(run(['PARTIAL']).adjustment.outcomeCode).toBe('NOT_NEEDED');
    expect(run(['UNDETERMINED', 'WORKING'])).toMatchObject({ planDate: '2027-03-01', adjustment: { outcomeCode: 'NOT_ADJUSTED_UNDETERMINED' } });
  });

  it('휴일만 건너뛰어 첫 비휴일로 옮긴다 — 판정 불가 날에도 옮긴다', () => {
    const adjusted = run(['HOLIDAY', 'HOLIDAY', 'WORKING']);
    expect(adjusted).toMatchObject({ planDate: '2027-03-03', adjustment: { originalDate: '2027-03-01', adjustedDate: '2027-03-03', outcomeCode: 'ADJUSTED', searchLimitDays: PLAN_DATE_SEARCH_LIMIT_DAYS } });
    expect(adjusted.adjustment.skippedDays.map((item) => item.date)).toEqual(['2027-03-01', '2027-03-02']);
    expect(adjusted.usedDays.map((item) => item.date)).toEqual(['2027-03-01', '2027-03-02', '2027-03-03']);
    expect(run(['HOLIDAY', 'UNDETERMINED'])).toMatchObject({ planDate: '2027-03-02', adjustment: { outcomeCode: 'ADJUSTED' } });
  });

  it('한도 안에 비휴일이 없으면 원래 날짜 그대로다', () => {
    const adjusted = run(Array.from({ length: PLAN_DATE_SEARCH_LIMIT_DAYS + 2 }, (_, index) => (index === PLAN_DATE_SEARCH_LIMIT_DAYS + 1 ? 'WORKING' : 'HOLIDAY')));
    expect(adjusted).toMatchObject({ planDate: '2027-03-01', adjustment: { outcomeCode: 'NOT_ADJUSTED_SEARCH_LIMIT', adjustedDate: null } });
    expect(adjusted.usedDays).toHaveLength(PLAN_DATE_SEARCH_LIMIT_DAYS + 1);
  });

  it('날짜 계산', () => {
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(daysBetween('2027-01-01', '2027-04-02')).toBe(92);
  });
});
