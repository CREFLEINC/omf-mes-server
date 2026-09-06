import { Prisma } from '@prisma/client';

import { NO_RESULTS, ProgressInput, preIssuedLotsOf, progressOf } from './work-order-progress';

const NOW = new Date('2026-09-06T00:00:00.000Z');

function input(orderQty: number, goodQty: number, overrides: Partial<ProgressInput> = {}): ProgressInput {
  return {
    orderQty: new Prisma.Decimal(orderQty),
    plannedEndAt: null,
    completedAt: null,
    sums: { ...NO_RESULTS, good_qty: new Prisma.Decimal(goodQty) },
    now: NOW,
    ...overrides,
  };
}

describe('WorkOrderProgress 집계', () => {
  it('progress — achievementRate 분모가 0 이면 키를 생략한다', () => {
    const zero = progressOf(input(0, 0));
    const normal = progressOf(input(100, 95));

    expect(Object.keys(zero)).not.toContain('achievementRate');
    expect(normal.achievementRate).toBeCloseTo(0.95, 10);
    // 나머지 수량 넷은 0 도 «값»으로 낸다 — 키를 생략하지 않는다.
    expect(zero).toMatchObject({ goodQty: 0, defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0 });
  });

  it('progress — completionJudgmentCode 는 정확 비교로 UNDER/NORMAL/OVER 를 가른다', () => {
    // 경계 셋 — 같음 · 1 적음 · 1 많음. 허용 오차 0 이라 1 만 어긋나도 정상이 아니다.
    expect(progressOf(input(100, 100)).completionJudgmentCode).toBe('NORMAL');
    expect(progressOf(input(100, 99)).completionJudgmentCode).toBe('UNDER');
    expect(progressOf(input(100, 101)).completionJudgmentCode).toBe('OVER');
    // varianceQty 는 지시 − 양품 — 초과면 음수다.
    expect(progressOf(input(100, 101)).varianceQty).toBe(-1);
  });

  it('progress — 계획 종료 시각이 없으면 UNDETERMINABLE 이고 ON_TIME 으로 접지 않는다', () => {
    const past = new Date('2026-09-05T00:00:00.000Z');
    expect(progressOf(input(100, 0)).delayStatusCode).toBe('UNDETERMINABLE');
    expect(progressOf(input(100, 0, { plannedEndAt: past })).delayStatusCode).toBe('DELAYED');
    expect(progressOf(input(100, 0, { plannedEndAt: past, completedAt: past })).delayStatusCode).toBe('ON_TIME');
  });

  it('preIssuedLots — withResultCount 는 production_result_lot_allocation 유무로 센다', () => {
    expect(preIssuedLotsOf([10n, 11n], [10n])).toEqual({
      slotCount: 2,
      withResultCount: 1,
      withoutResultCount: 1,
    });
    // 슬롯이 0 이면 셋 다 0 이다 — required 라 키를 생략하지 않는다.
    expect(preIssuedLotsOf([], [])).toEqual({ slotCount: 0, withResultCount: 0, withoutResultCount: 0 });
  });
});
