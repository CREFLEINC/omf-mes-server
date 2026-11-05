import { dayStartOf, dayWindow, shiftWindow, timeOfColumn, zonedToUtc } from './plan-window';

describe('plan-window — 근무일 하루', () => {
  it('공장 벽시계를 UTC 로 바꾼다 — 서버 TZ 와 무관하다', () => {
    expect(zonedToUtc('2026-11-20', '07:00:00', 'Asia/Ho_Chi_Minh').toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(zonedToUtc('2026-11-20', '07:00:00', 'Asia/Seoul').toISOString()).toBe('2026-11-19T22:00:00.000Z');
    expect(zonedToUtc('2026-11-20', '07:00:00', 'UTC').toISOString()).toBe('2026-11-20T07:00:00.000Z');
  });

  it('서머타임이 있는 시간대도 그날의 오프셋을 쓴다', () => {
    expect(zonedToUtc('2026-07-01', '07:00:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T05:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '07:00:00', 'Europe/Berlin').toISOString()).toBe('2026-12-01T06:00:00.000Z');
  });

  it('하루는 시작부터 24시간이다 — 자정을 넘긴 야간도 계획일에 든다', () => {
    const window = dayWindow('2026-11-20', '07:00:00', 'Asia/Ho_Chi_Minh');
    expect(window.plannedStartAt.toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(window.plannedEndAt.toISOString()).toBe('2026-11-21T00:00:00.000Z');
  });

  it('`@db.Time` 값에서 HH:MM:SS 를 떼어 낸다', () => {
    expect(timeOfColumn(new Date('1970-01-01T19:30:00.000Z'))).toBe('19:30:00');
  });
});

/** 화면 4M 배정(`assignment-model.ts` 의 `plannedWindowLocal`)과 같은 사례 — 공장 시각으로 본다. */
describe('plan-window — 교대 창', () => {
  const HCM = 'Asia/Ho_Chi_Minh';
  const local = (instant: Date): string =>
    new Date(instant.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const shifts = [
    { startTime: '07:00:00', endTime: '19:00:00', crossesMidnight: false, isActive: true },
    { startTime: '19:00:00', endTime: '07:00:00', crossesMidnight: true, isActive: true },
    { startTime: '05:00:00', endTime: '13:00:00', crossesMidnight: false, isActive: false },
  ];
  const activeStarts = shifts.filter((shift) => shift.isActive).map((shift) => shift.startTime);

  it('주간을 고르면 그날 교대 시각이다', () => {
    const window = shiftWindow('2026-10-20', shifts[0], HCM);
    expect([local(window.plannedStartAt), local(window.plannedEndAt)]).toEqual(['2026-10-20T07:00', '2026-10-20T19:00']);
  });

  it('자정을 넘기는 야간은 다음 날 끝난다', () => {
    const window = shiftWindow('2026-10-20', shifts[1], HCM);
    expect([local(window.plannedStartAt), local(window.plannedEndAt)]).toEqual(['2026-10-20T19:00', '2026-10-21T07:00']);
  });

  it('교대를 비우면 근무일 하루 — 가장 이른 «활성» 교대 시작부터 24시간이다', () => {
    const window = dayWindow('2026-10-31', dayStartOf(activeStarts), HCM);
    expect([local(window.plannedStartAt), local(window.plannedEndAt)]).toEqual(['2026-10-31T07:00', '2026-11-01T07:00']);
  });

  it('교대가 하나도 없으면 08:00 부터 24시간이다', () => {
    const window = dayWindow('2026-12-31', dayStartOf([]), HCM);
    expect([local(window.plannedStartAt), local(window.plannedEndAt)]).toEqual(['2026-12-31T08:00', '2027-01-01T08:00']);
  });
});
