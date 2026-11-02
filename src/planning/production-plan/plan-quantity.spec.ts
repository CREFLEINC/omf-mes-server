import { Prisma } from '@prisma/client';

import { PlanQtyFact, isPlanCancelled, planQuantities, sumPlanQty } from './plan-quantity';

const qty = (value: number) => new Prisma.Decimal(value);
const plan = (overrides: Partial<PlanQtyFact>): PlanQtyFact => ({ confirmed: false, cancelled: false, plannedQty: qty(10), ...overrides });

describe('isPlanCancelled — 확정 계획의 취소 판정', () => {
  it('W/O 가 하나도 없으면 취소가 아니다', () => {
    expect(isPlanCancelled([])).toBe(false);
  });

  it('W/O 가 전부 CANCELLED 일 때만 취소다', () => {
    expect(isPlanCancelled(['CANCELLED', 'CANCELLED'])).toBe(true);
    expect(isPlanCancelled(['CANCELLED', 'PLANNED'])).toBe(false);
  });
});

describe('sumPlanQty — 확정 계획량과 작성 수량', () => {
  it('취소된 확정 계획은 확정 계획량에서 빠진다', () => {
    const sums = sumPlanQty([
      plan({ confirmed: true, plannedQty: qty(60) }),
      plan({ confirmed: true, cancelled: true, plannedQty: qty(30) }),
      plan({ plannedQty: qty(5) }),
    ]);
    expect([sums.confirmedQty.toNumber(), sums.draftQty.toNumber()]).toEqual([60, 5]);
  });
});

describe('planQuantities — 잔량과 계획 상태', () => {
  const of = (confirmed: number, draft: number) => {
    const q = planQuantities(qty(100), qty(confirmed), qty(draft));
    return [q.remainingQty.toNumber(), q.status];
  };

  it('계획이 없으면 미계획이고 잔량은 오더량이다', () => {
    expect(of(0, 0)).toEqual([100, 'UNPLANNED']);
  });

  it('일부만 계획했으면 부분계획이다 — 확정과 작성을 함께 뺀다', () => {
    expect(of(40, 20)).toEqual([40, 'PARTIAL']);
  });

  it('작성중만으로 채워도 잔량 0 이면 계획완료다', () => {
    expect(of(0, 100)).toEqual([0, 'PLANNED']);
  });

  it('이미 넘은 계획은 잔량이 음수다', () => {
    expect(of(120, 0)).toEqual([-20, 'PLANNED']);
  });
});
