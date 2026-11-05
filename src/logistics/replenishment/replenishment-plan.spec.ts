import { Prisma } from '@prisma/client';

import { ManagedItemState, createdResult, decide, isDue, localClock } from './replenishment-plan';

const d = (value: number) => new Prisma.Decimal(value);
// 보충 시점 50 · 유지량 200(spec 예시).
const item = (usable: number, over: Partial<ManagedItemState> = {}): ManagedItemState => ({
  itemId: 1n,
  reorderPointQty: d(50),
  targetQty: d(200),
  usableQty: d(usable),
  inProgressRequestCount: 0,
  sourceActive: true,
  ...over,
});
const qty = (decision: ReturnType<typeof decide>) => (decision.kind === 'REQUEST' ? decision.qty.toNumber() : decision);

describe('자동 보충 판단 (피처 004 · US5)', () => {
  it('US5-1 가용 80·예정 40 → 쓸 수 있는 양 40 → 유지량까지 160', () => {
    expect(qty(decide(item(80 - 40)))).toBe(160);
  });

  it('US5-2 쓸 수 있는 양 60 → 보충 없음', () => {
    expect(decide(item(60))).toEqual({ kind: 'ABOVE' });
  });

  it('US5-3 정확히 보충 시점 50 → 보충 없음', () => {
    expect(decide(item(50))).toEqual({ kind: 'ABOVE' });
  });

  it('US5-4 진행 중 요청이 있으면 건너뜀 IN_PROGRESS — 출고 자재 창고 비활성은 SOURCE_INACTIVE', () => {
    expect(decide(item(10, { inProgressRequestCount: 1 }))).toEqual({ kind: 'SKIP', result: 'IN_PROGRESS' });
    expect(decide(item(10, { sourceActive: false }))).toEqual({ kind: 'SKIP', result: 'SOURCE_INACTIVE' });
  });

  it('쓸 수 있는 양이 음수면 유지량보다 많이 요청한다', () => {
    expect(qty(decide(item(-30)))).toBe(230);
  });

  it('만든 줄 결과 — 그대로 CREATED, 줄였으면 SHORTAGE, 못 만들었으면 NO_SOURCE_STOCK', () => {
    expect(createdResult(d(160), d(0))).toBe('CREATED');
    expect(createdResult(d(100), d(60))).toBe('SHORTAGE');
    expect(createdResult(d(0), d(160))).toBe('NO_SOURCE_STOCK');
  });

  it('실행 대상 — 현지 시각 ≥ 실행 시각이고 오늘 기록이 없을 때', () => {
    expect(isDue('01:00', '01:00', false)).toBe(true);
    expect(isDue('00:59', '01:00', false)).toBe(false);
    expect(isDue('23:10', '07:00', false)).toBe(true);
    expect(isDue('08:00', '07:00', true)).toBe(false);
  });

  it('현지 벽시계는 공장 시간대로 푼다(캐스팅 없이)', () => {
    const instant = new Date('2026-11-05T18:00:30Z');
    expect(localClock(instant, 'Asia/Ho_Chi_Minh')).toBe('01:00');
    expect(localClock(instant, 'Asia/Seoul')).toBe('03:00');
  });
});
