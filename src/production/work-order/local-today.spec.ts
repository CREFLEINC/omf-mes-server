import { localToday } from './validation';

/** 4M 점검·작업자 추천·계획 제안의 「오늘」 — 공장 현지 날짜다(omf-all-around#238). */
describe('localToday', () => {
  const day = (value: Date): string => value.toISOString().slice(0, 10);

  it.each([
    ['2026-11-04T16:59:59.000Z', '2026-11-04'],
    ['2026-11-04T17:00:00.000Z', '2026-11-05'],
    ['2026-11-04T23:59:59.000Z', '2026-11-05'],
    ['2026-11-05T00:00:00.000Z', '2026-11-05'],
  ])('UTC %s 는 현지(Asia/Ho_Chi_Minh) %s 다', (now, expected) => {
    expect(day(localToday(new Date(now), 'Asia/Ho_Chi_Minh'))).toBe(expected);
  });

  it('`@db.Date` 와 같은 UTC 자정 모양이다', () => {
    expect(localToday(new Date('2026-11-04T20:00:00.000Z'), 'Asia/Ho_Chi_Minh').toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('공장을 모르면 현장 시간대의 오늘이다', () => {
    expect(day(localToday(new Date('2026-11-04T20:00:00.000Z'), null))).toBe('2026-11-05');
  });

  it('다른 시간대 공장은 그 시간대로 푼다', () => {
    expect(day(localToday(new Date('2026-11-04T20:00:00.000Z'), 'UTC'))).toBe('2026-11-04');
  });
});
