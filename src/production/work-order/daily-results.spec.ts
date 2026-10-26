import { Prisma } from '@prisma/client';

import { DailyResultRow, ResultShift, businessDateOf, dailyResultsOf } from './daily-results';

const TZ = 'Asia/Ho_Chi_Minh';
const time = (hhmmss: string) => new Date(`1970-01-01T${hhmmss}.000Z`);
const DAY: ResultShift = { shift_id: 1n, shift_name: '주간', end_time: time('20:00:00'), crosses_midnight: false };
const NIGHT: ResultShift = { shift_id: 2n, shift_name: '야간', end_time: time('08:00:00'), crosses_midnight: true };

/** 현지(UTC+7) 시각으로 적는다. */
const local = (iso: string) => new Date(`${iso}+07:00`);

function row(at: string, shift: ResultShift | null, good: number, extra: Partial<DailyResultRow> = {}): DailyResultRow {
  const zero = new Prisma.Decimal(0);
  return {
    good_qty: new Prisma.Decimal(good), defect_qty: zero, hold_qty: zero, scrap_qty: zero, rework_qty: zero,
    occurred_at: local(at), corrects_production_result_id: null, shift, ...extra,
  };
}

describe('businessDateOf', () => {
  it('교대가 없으면 공장 현지 날짜다 — UTC 날짜가 아니다', () => {
    expect(businessDateOf(local('2026-10-21T06:30:00'), TZ, null)).toBe('2026-10-21');
    expect(businessDateOf(local('2026-10-21T23:59:59'), TZ, null)).toBe('2026-10-21');
  });

  it('자정을 넘는 교대의 새벽 실적은 교대 시작일이다', () => {
    expect(businessDateOf(local('2026-10-21T22:00:00'), TZ, NIGHT)).toBe('2026-10-21');
    expect(businessDateOf(local('2026-10-22T00:00:00'), TZ, NIGHT)).toBe('2026-10-21');
    expect(businessDateOf(local('2026-10-22T07:59:59'), TZ, NIGHT)).toBe('2026-10-21');
  });

  it('교대 끝 시각 정각부터는 그날이다(반열림)', () => {
    expect(businessDateOf(local('2026-10-22T08:00:00'), TZ, NIGHT)).toBe('2026-10-22');
  });

  it('자정을 넘지 않는 교대는 현지 날짜 그대로다', () => {
    expect(businessDateOf(local('2026-10-22T07:00:00'), TZ, DAY)).toBe('2026-10-22');
  });

  it('월 첫날 새벽의 야간 실적은 전달 말일이다', () => {
    expect(businessDateOf(local('2026-11-01T02:00:00'), TZ, NIGHT)).toBe('2026-10-31');
  });
});

describe('dailyResultsOf', () => {
  it('영업일 오름차순으로 묶고, 첫·마지막 시각과 합계를 낸다', () => {
    const result = dailyResultsOf([
      row('2026-10-22T10:00:00', DAY, 5),
      row('2026-10-21T21:00:00', NIGHT, 3),
      row('2026-10-22T03:00:00', NIGHT, 2),
    ], TZ);

    expect(result.items.map((item) => [item.businessDate, item.goodQty, item.resultCount])).toEqual([
      ['2026-10-21', 5, 2],
      ['2026-10-22', 5, 1],
    ]);
    expect(result.items[0]).toMatchObject({
      firstAt: local('2026-10-21T21:00:00').toISOString(),
      lastAt: local('2026-10-22T03:00:00').toISOString(),
    });
    expect(result.totals).toEqual({ goodQty: 10, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 3, correctedCount: 0 });
  });

  it('정정본은 correctedCount 로 센다 — 수량은 들어온 잎 그대로 더한다', () => {
    const result = dailyResultsOf([
      row('2026-10-21T09:00:00', DAY, 4, { corrects_production_result_id: 7n, defect_qty: new Prisma.Decimal(1) }),
      row('2026-10-21T11:00:00', DAY, 6),
    ], TZ);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ goodQty: 10, defectQty: 1, resultCount: 2, correctedCount: 1 });
  });

  it('교대별은 교대 id 순, 교대 없는 실적은 shiftId 없이 맨 뒤다', () => {
    const result = dailyResultsOf([
      row('2026-10-21T10:00:00', null, 1),
      row('2026-10-21T21:00:00', NIGHT, 2),
      row('2026-10-21T10:30:00', DAY, 3),
      row('2026-10-21T12:00:00', DAY, 4),
    ], TZ);

    expect(result.items[0].byShift).toEqual([
      { shiftId: 1, shiftName: '주간', goodQty: 7, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 2, correctedCount: 0 },
      { shiftId: 2, shiftName: '야간', goodQty: 2, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 1, correctedCount: 0 },
      { goodQty: 1, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 1, correctedCount: 0 },
    ]);
  });

  it('실적이 없으면 빈 목록과 0 합계다', () => {
    expect(dailyResultsOf([], TZ)).toEqual({
      items: [],
      totals: { goodQty: 0, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 0, correctedCount: 0 },
    });
  });
});
