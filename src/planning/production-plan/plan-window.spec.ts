import { dayWindow, timeOfColumn, zonedToUtc } from './plan-window';

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
