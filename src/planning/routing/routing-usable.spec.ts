import { plantToday, siteToday, usableWhere } from './routing.service';

/** omf-all-around#218 — Routing 유효 판정의 「오늘」은 UTC 가 아니라 현지 날짜다. */
describe('Routing 사용 가능 판정의 오늘', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['2026-11-04T16:59:59Z', '2026-11-04'], // 현지 23:59
    ['2026-11-04T17:00:00Z', '2026-11-05'], // 현지 00:00 — UTC 는 아직 11-04
    ['2026-11-04T23:59:59Z', '2026-11-05'], // 현지 06:59
    ['2026-11-05T00:00:00Z', '2026-11-05'], // 현지 07:00
  ])('현장 시간대의 오늘 — %s 는 %s', (instant, expected) => {
    expect(siteToday(new Date(instant))).toBe(expected);
  });

  it('공장의 시간대로 오늘을 푼다', async () => {
    const findUniqueOrThrow = jest.fn().mockResolvedValue({ timezone_code: 'Asia/Ho_Chi_Minh' });
    await expect(plantToday({ plant: { findUniqueOrThrow } } as never, 2n, new Date('2026-11-04T18:00:00Z'))).resolves.toBe('2026-11-05');
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { plant_id: 2n }, select: { timezone_code: true } });
  });

  it('넘긴 현지 날짜로 유효 기간을 본다', () => {
    const today = new Date('2026-11-05');
    expect(usableWhere('2026-11-05')).toEqual({
      status_code: 'CONFIRMED',
      AND: [
        { OR: [{ effective_from: null }, { effective_from: { lte: today } }] },
        { OR: [{ effective_to: null }, { effective_to: { gte: today } }] },
      ],
    });
  });

  it('날짜를 안 넘기면 현장의 오늘이다 — 현지 00:00~07:00 에도 UTC 전날로 읽지 않는다', () => {
    jest.useFakeTimers({ now: new Date('2026-11-04T20:00:00Z') }); // 현지 11-05 03:00
    expect(usableWhere()).toEqual(usableWhere('2026-11-05'));
    expect(usableWhere()).not.toEqual(usableWhere('2026-11-04'));
  });
});
