import { Prisma } from '@prisma/client';

import { workOrderListSummaryOf } from './work-order-summary';

const dec = (value: string) => new Prisma.Decimal(value);

const NO_QTY = { good_qty: null, defect_qty: null, hold_qty: null, scrap_qty: null, rework_qty: null };

describe('workOrderListSummaryOf', () => {
  it('요약 — statusCounts 는 0건 상태의 키를 내지 않는다', () => {
    const summary = workOrderListSummaryOf({
      totalCount: 3,
      statusCounts: [{ status_code: 'PLANNED', _count: { work_order_id: 3 } }],
      orderQtySum: dec('100'),
      resultSums: NO_QTY,
      delayedCount: 0,
      undeterminableDelayCount: 0,
    });

    expect(summary.statusCounts).toEqual({ PLANNED: 3 });
    // 시드 8값 중 나머지 일곱은 «키 자체가 없다» — 0 값 키를 지어내지 않는다.
    expect(summary.statusCounts).not.toHaveProperty('CLOSED');
    expect(summary.statusCounts).not.toHaveProperty('CANCELLED');
  });

  it('요약 — undeterminableDelayCount 를 delayedCount 에 접지 않는다', () => {
    const summary = workOrderListSummaryOf({
      totalCount: 2,
      statusCounts: [],
      orderQtySum: dec('0'),
      resultSums: NO_QTY,
      delayedCount: 1,
      undeterminableDelayCount: 1,
    });

    // 서로 다른 축이라 하나가 늘어도 다른 하나가 줄지 않는다 — 접히면 둘 다 1일 수 없다.
    expect(summary.delayedCount).toBe(1);
    expect(summary.undeterminableDelayCount).toBe(1);
  });

  it('요약 — 쪽과 무관하게 필터 전체를 센다', () => {
    // 매퍼는 「쪽」 개념을 아예 모른다 — 넘겨받은 totalCount 를 그대로 낸다(자르지 않는다).
    const summary = workOrderListSummaryOf({
      totalCount: 137,
      statusCounts: [],
      orderQtySum: dec('1000'),
      resultSums: { ...NO_QTY, good_qty: dec('300') },
      delayedCount: 4,
      undeterminableDelayCount: 2,
    });

    expect(summary.totalCount).toBe(137);
    expect(summary.achievementRate).toBeCloseTo(0.3);
  });

  it('achievementRate 는 분모 0 이면 키를 생략한다', () => {
    const summary = workOrderListSummaryOf({
      totalCount: 0,
      statusCounts: [],
      orderQtySum: null,
      resultSums: NO_QTY,
      delayedCount: 0,
      undeterminableDelayCount: 0,
    });

    expect(summary).not.toHaveProperty('achievementRate');
    // 여덟 카운트는 0 도 값으로 낸다 — 키를 생략하지 않는다.
    expect(summary.totalCount).toBe(0);
    expect(summary.goodQty).toBe(0);
    expect(summary.delayedCount).toBe(0);
  });
});
