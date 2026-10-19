import {
  DailyProduction,
  availabilityCard,
  oeeCard,
  performanceCard,
  productionCards,
  productionSection,
  productionTrend,
  trailingDays,
} from './dashboard-view';

const day = (value: Partial<DailyProduction> & { day: string }): [string, DailyProduction] => [
  value.day,
  { totalQty: 0, goodQty: 0, ngQty: 0, holdQty: 0, reworkGoodQty: 0, ...value },
];

const availability = { plannedMs: 8 * 3_600_000, actualMs: 6 * 3_600_000, equipmentCount: 2, excludedSessionCount: 0 };

describe('dashboard view', () => {
  it('trailingDays 는 기준일을 끝으로 월 경계를 넘는다', () => {
    expect(trailingDays('2026-10-02', 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('생산 수량은 전일 대비를 내고, 양품률은 재작업 합격분을 양품으로 옮긴다', () => {
    const byDay = new Map([
      day({ day: '2026-10-15', totalQty: 800 }),
      day({ day: '2026-10-16', totalQty: 1000, goodQty: 900, reworkGoodQty: 50 }),
    ]);
    const [production, yieldRate] = productionCards(byDay, '2026-10-16');
    expect(production).toMatchObject({ cardCode: 'PRODUCTION_QTY', value: 1000, deltaRatio: 0.25, valueStatusCode: 'AVAILABLE' });
    expect(yieldRate).toMatchObject({ cardCode: 'YIELD_RATE', value: 95, unit: '%', valueStatusCode: 'AVAILABLE' });
  });

  it('재작업 합격분으로 양품률이 100% 를 넘으면 자르지 않고 note 를 붙인다', () => {
    const byDay = new Map([day({ day: '2026-10-16', totalQty: 100, goodQty: 100, reworkGoodQty: 20 })]);
    const [, yieldRate] = productionCards(byDay, '2026-10-16');
    expect(yieldRate).toMatchObject({ value: 120, note: '재작업 합격분 포함' });
  });

  it('실적이 없으면 생산 수량은 0, 양품률은 NOT_YET, 전일 실적이 없으면 증감을 비운다', () => {
    const [production, yieldRate] = productionCards(new Map(), '2026-10-16');
    expect(production.value).toBe(0);
    expect(production).not.toHaveProperty('deltaRatio');
    expect(yieldRate.valueStatusCode).toBe('NOT_YET');
  });

  it('공장 생산 합은 카드와 같은 총생산이고, NG 는 재작업 합격분만큼 줄어든다', () => {
    const byDay = new Map([
      day({ day: '2026-10-16', totalQty: 1000, goodQty: 880, ngQty: 100, holdQty: 20, reworkGoodQty: 30 }),
    ]);
    const section = productionSection(byDay, '2026-10-16');
    expect(section).toMatchObject({ totalQty: 1000, goodQty: 910, ngQty: 70, holdQty: 20 });
    expect(section.defectRate).toBeCloseTo(7, 9);
    expect(productionSection(new Map(), '2026-10-16')).toEqual({
      totalQty: 0,
      goodQty: 0,
      ngQty: 0,
      holdQty: 0,
      defectRate: null,
    });
  });

  it('추이는 기준일 포함 9일이고 실적 없는 날은 0, 라벨은 MM-DD 다', () => {
    const trend = productionTrend(new Map([day({ day: '2026-10-14', totalQty: 30 })]), '2026-10-16', 'now');
    expect(trend.points).toHaveLength(9);
    expect(trend.points[0]).toEqual({ label: '10-08', value: 0 });
    expect(trend.points[6]).toEqual({ label: '10-14', value: 30 });
    expect(trend.points.at(-1)).toEqual({ label: '10-16', value: 0 });
    expect(trend).toMatchObject({ seriesName: '일일 생산실적', unit: 'EA', targetValue: null });
  });

  it('시간가동률 = 실제 ÷ 계획, 설비 없는 세션이 있으면 PARTIAL', () => {
    expect(availabilityCard(availability)).toMatchObject({ value: 75, valueStatusCode: 'AVAILABLE' });
    expect(availabilityCard({ ...availability, excludedSessionCount: 3 })).toMatchObject({
      valueStatusCode: 'PARTIAL',
      excludedCount: 3,
    });
  });

  it('시간가동률은 작업 설비가 없거나 달력을 못 풀면 NOT_YET', () => {
    expect(availabilityCard({ ...availability, equipmentCount: 0 }).valueStatusCode).toBe('NOT_YET');
    expect(availabilityCard({ ...availability, plannedMs: null }).valueStatusCode).toBe('NOT_YET');
  });

  it('성능가동률은 100% 를 넘어도 자르지 않고, C/T 없는 실적이 있으면 PARTIAL', () => {
    const card = performanceCard({ idealSec: 7 * 3600, includedResultCount: 4, excludedResultCount: 1 }, availability);
    expect(card.value).toBeCloseTo(116.67, 2);
    expect(card).toMatchObject({ valueStatusCode: 'PARTIAL', excludedCount: 1 });
    expect(
      performanceCard({ idealSec: 0, includedResultCount: 0, excludedResultCount: 2 }, availability).valueStatusCode,
    ).toBe('NOT_YET');
  });

  it('OEE = 세 비율의 곱, 하나라도 NOT_YET 이면 NOT_YET, PARTIAL 이 섞이면 PARTIAL', () => {
    const rate = (value: number, valueStatusCode: 'AVAILABLE' | 'PARTIAL' | 'NOT_YET' = 'AVAILABLE') => ({
      cardCode: 'YIELD_RATE' as const,
      label: '',
      value,
      valueStatusCode,
    });
    expect(oeeCard([rate(90), rate(80), rate(50)]).value).toBeCloseTo(36, 6);
    expect(oeeCard([rate(90), rate(80, 'PARTIAL'), rate(50)]).valueStatusCode).toBe('PARTIAL');
    expect(oeeCard([rate(90), rate(0, 'NOT_YET'), rate(50)]).valueStatusCode).toBe('NOT_YET');
  });
});
