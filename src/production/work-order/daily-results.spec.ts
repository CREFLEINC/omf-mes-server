import { Prisma } from '@prisma/client';

import { DailyResultRow, ResultShift, dailyResultsOf, shiftOfResult, workDateOf } from './daily-results';

const TZ = 'Asia/Ho_Chi_Minh';
const time = (hhmmss: string) => new Date(`1970-01-01T${hhmmss}.000Z`);
// id 순과 시작 시각 순이 반대다 — 교대별 정렬이 시작 시각을 따르는지 가른다.
const DAY: ResultShift = { shift_id: 3n, shift_name: '주간', start_time: time('07:00:00'), end_time: time('19:00:00'), crosses_midnight: false };
const NIGHT: ResultShift = { shift_id: 2n, shift_name: '야간', start_time: time('19:00:00'), end_time: time('07:00:00'), crosses_midnight: true };
const PLANT_SHIFTS = [NIGHT, DAY];

/** 현지(UTC+7) 시각으로 적는다. */
const local = (iso: string) => new Date(`${iso}+07:00`);

function row(at: string, shift: ResultShift | null, good: number, extra: Partial<DailyResultRow> = {}): DailyResultRow {
  const zero = new Prisma.Decimal(0);
  return {
    good_qty: new Prisma.Decimal(good), defect_qty: zero, hold_qty: zero, scrap_qty: zero, rework_qty: zero,
    occurred_at: local(at), corrects_production_result_id: null, timezone: TZ, shift, ...extra,
  };
}

/** 실적에 교대가 없을 때 서비스가 하는 판정 그대로 — 교대를 실적 시각으로 정한 뒤 일자를 낸다. */
const workDateAt = (at: string, own: ResultShift | null = null) =>
  workDateOf(local(at), TZ, shiftOfResult(own, local(at), TZ, PLANT_SHIFTS));

describe('shiftOfResult', () => {
  it('실적에 교대가 있으면 그것이다 — 실적 시각이 그 교대 밖이어도', () => {
    expect(shiftOfResult(NIGHT, local('2026-10-22T07:05:00'), TZ, PLANT_SHIFTS)).toBe(NIGHT);
  });

  it('없으면 실적 시각으로 교대를 다시 판정한다 — 끝 정각은 다음 교대다', () => {
    expect(shiftOfResult(null, local('2026-10-22T06:59:59'), TZ, PLANT_SHIFTS)).toBe(NIGHT);
    expect(shiftOfResult(null, local('2026-10-22T07:00:00'), TZ, PLANT_SHIFTS)).toBe(DAY);
    expect(shiftOfResult(null, local('2026-10-22T07:05:00'), TZ, PLANT_SHIFTS)).toBe(DAY);
  });

  it('공장에 교대가 없거나 어느 교대에도 안 들면 null 이다', () => {
    expect(shiftOfResult(null, local('2026-10-22T10:00:00'), TZ, [])).toBeNull();
    expect(shiftOfResult(null, local('2026-10-22T03:00:00'), TZ, [DAY])).toBeNull();
  });
});

describe('workDateOf', () => {
  it('교대가 없으면 공장 현지 날짜다 — UTC 날짜가 아니다', () => {
    expect(workDateOf(local('2026-10-21T06:30:00'), TZ, null)).toBe('2026-10-21');
    expect(workDateOf(local('2026-10-21T23:59:59'), TZ, null)).toBe('2026-10-21');
  });

  it('자정을 넘는 교대의 새벽 실적은 교대 시작일이다', () => {
    expect(workDateAt('2026-10-21T22:00:00')).toBe('2026-10-21');
    expect(workDateAt('2026-10-22T00:00:00')).toBe('2026-10-21');
    expect(workDateAt('2026-10-22T06:59:59')).toBe('2026-10-21');
  });

  it('야간 끝(07:00) 뒤 07:05 실적은 주간이고 그날이다 — 야간 세션에서 넣었어도 세션 교대를 따르지 않는다', () => {
    expect(workDateAt('2026-10-22T07:05:00')).toBe('2026-10-22');
  });

  it('닫지 않은 야간 세션이 다음 날 낮까지 이어져도 낮 실적은 주간·그날이다', () => {
    expect(shiftOfResult(null, local('2026-10-22T14:00:00'), TZ, PLANT_SHIFTS)).toBe(DAY);
    expect(workDateAt('2026-10-22T14:00:00')).toBe('2026-10-22');
  });

  it('실적에 야간이 적혀 있으면 07:05 실적도 야간이지만, 끝 시각을 지났으니 그날이다', () => {
    expect(workDateAt('2026-10-22T07:05:00', NIGHT)).toBe('2026-10-22');
    expect(workDateAt('2026-10-22T06:00:00', NIGHT)).toBe('2026-10-21');
  });

  it('월 첫날 새벽의 야간 실적은 전달 말일이다', () => {
    expect(workDateAt('2026-11-01T02:00:00')).toBe('2026-10-31');
  });
});

describe('dailyResultsOf', () => {
  it('영업일 오름차순으로 묶고, 첫·마지막 시각과 합계를 낸다', () => {
    const result = dailyResultsOf([
      row('2026-10-22T10:00:00', DAY, 5),
      row('2026-10-21T21:00:00', NIGHT, 3),
      row('2026-10-22T03:00:00', NIGHT, 2),
    ]);

    expect(result.items.map((item) => [item.workDate, item.goodQty, item.resultCount])).toEqual([
      ['2026-10-21', 5, 2],
      ['2026-10-22', 5, 1],
    ]);
    expect(result.items[0]).toMatchObject({
      firstAt: local('2026-10-21T21:00:00').toISOString(),
      lastAt: local('2026-10-22T03:00:00').toISOString(),
    });
    expect(result.totals).toEqual({ goodQty: 10, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 3, correctedCount: 0 });
  });

  it('정정본은 correctedCount 로 센다 — 수량 0 정정(취소)도 실적 하나로 센다', () => {
    const result = dailyResultsOf([
      row('2026-10-21T09:00:00', DAY, 4, { corrects_production_result_id: 7n, defect_qty: new Prisma.Decimal(1) }),
      row('2026-10-21T10:00:00', DAY, 0, { corrects_production_result_id: 8n }),
      row('2026-10-21T11:00:00', DAY, 6),
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ goodQty: 10, defectQty: 1, resultCount: 3, correctedCount: 2 });
  });

  it('교대별은 교대 시작 시각 순, 교대 없는 실적은 shiftId null 「교대 없음」 한 줄로 맨 뒤다', () => {
    const result = dailyResultsOf([
      row('2026-10-21T10:00:00', null, 1),
      row('2026-10-21T21:00:00', NIGHT, 2),
      row('2026-10-21T10:30:00', DAY, 3),
      row('2026-10-21T12:00:00', DAY, 4),
    ]);

    expect(result.items[0].byShift).toEqual([
      { shiftId: 3, shiftName: '주간', goodQty: 7, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 2, correctedCount: 0 },
      { shiftId: 2, shiftName: '야간', goodQty: 2, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 1, correctedCount: 0 },
      { shiftId: null, shiftName: '교대 없음', goodQty: 1, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 1, correctedCount: 0 },
    ]);
  });

  it('실적이 없으면 빈 목록과 0 합계다', () => {
    expect(dailyResultsOf([])).toEqual({
      items: [],
      totals: { goodQty: 0, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0, resultCount: 0, correctedCount: 0 },
    });
  });
});
