import { Prisma } from '@prisma/client';

import { DefaultMap, OperationNeed } from '../production-plan/resource-assign';
import { AutoPlanReason, PlanFact, autoPlanView, chooseMasters, expansionHasLine } from './auto-plan';

const qty = (value: number) => new Prisma.Decimal(value);
/** 자동 계획을 시도한 오더의 상태. */
const attempted = (orderQty: Prisma.Decimal, plans: PlanFact[], unplanned: AutoPlanReason[]) => autoPlanView(orderQty, plans, unplanned, true);
const plan = (overrides: Partial<PlanFact>): PlanFact => ({ confirmed: false, plannedQty: qty(100), lineKnown: true, ...overrides });
const injection: OperationNeed = { routingOperationId: 101n, processId: 1n, equipmentRequired: true, moldRequired: true };
const map = (overrides: Partial<DefaultMap>): DefaultMap => ({ processId: null, equipmentId: null, equipmentLineId: null, moldId: null, ...overrides });

describe('chooseMasters — 자동 계획의 BOM·Routing 선택(W-02-02 자동 선택과 같은 규칙)', () => {
  it('기본 BOM 하나와 쓸 수 있는 Routing 하나면 그 둘을 고른다', () => {
    expect(chooseMasters([11n], [{ routingId: 21n, isDefault: false }])).toEqual({ bomId: 11n, routingId: 21n, reasons: [] });
  });

  it('기본 BOM 이 없으면 BOM_MISSING', () => {
    expect(chooseMasters([], [{ routingId: 21n, isDefault: false }])).toEqual({ bomId: null, routingId: 21n, reasons: ['BOM_MISSING'] });
  });

  it('쓸 수 있는 Routing 이 없으면 ROUTING_MISSING', () => {
    expect(chooseMasters([11n], [])).toEqual({ bomId: 11n, routingId: null, reasons: ['ROUTING_MISSING'] });
  });

  it('쓸 수 있는 Routing 이 여럿이면 그중 기본 Rev 를 고른다', () => {
    const routings = [{ routingId: 21n, isDefault: false }, { routingId: 22n, isDefault: true }];
    expect(chooseMasters([11n], routings).routingId).toBe(22n);
  });

  it('쓸 수 있는 Routing 이 여럿인데 기본이 없으면 ROUTING_AMBIGUOUS', () => {
    const routings = [{ routingId: 21n, isDefault: false }, { routingId: 22n, isDefault: false }];
    expect(chooseMasters([11n], routings)).toEqual({ bomId: 11n, routingId: null, reasons: ['ROUTING_AMBIGUOUS'] });
  });

  it('BOM·Routing 이 둘 다 막히면 사유를 둘 다 낸다', () => {
    expect(chooseMasters([], []).reasons).toEqual(['BOM_MISSING', 'ROUTING_MISSING']);
  });
});

describe('expansionHasLine — 전개한 W/O 에 라인이 서는가', () => {
  it('계획 라인이 있으면 매핑과 무관하게 선다', () => {
    expect(expansionHasLine(7n, [injection], [])).toBe(true);
  });

  it('계획 라인이 없어도 배정될 설비가 라인에 속하면 선다', () => {
    expect(expansionHasLine(null, [injection], [map({ equipmentId: 51n, equipmentLineId: 22n })])).toBe(true);
  });

  it('금형만 매핑되면 라인을 모른다', () => {
    expect(expansionHasLine(null, [injection], [map({ moldId: 61n })])).toBe(false);
  });

  it('설비가 라인에 속하지 않으면 라인을 모른다', () => {
    expect(expansionHasLine(null, [injection], [map({ equipmentId: 51n })])).toBe(false);
  });

  it('공정이 없으면 라인을 모른다', () => {
    expect(expansionHasLine(null, [], [map({ equipmentId: 51n, equipmentLineId: 22n })])).toBe(false);
  });
});

describe('autoPlanView — 목록·상세의 자동 계획 상태', () => {
  it('확정 계획 수량이 오더 수량을 채우면 DONE 이고 사유가 없다', () => {
    expect(attempted(qty(100), [plan({ confirmed: true, plannedQty: qty(60) }), plan({ confirmed: true, plannedQty: qty(40) })], [])).toEqual({
      status: 'DONE',
      reasons: [],
    });
  });

  it('계획이 없으면 자동 계획을 막은 사유를 낸다', () => {
    expect(attempted(qty(100), [], ['ROUTING_MISSING'])).toEqual({ status: 'NEEDS_REVIEW', reasons: ['ROUTING_MISSING'] });
  });

  it('계획이 있으면 계획 전 사유는 보지 않는다', () => {
    expect(attempted(qty(100), [plan({})], ['ROUTING_MISSING'])?.reasons).toEqual(['PLAN_NOT_CONFIRMED']);
  });

  it('라인을 몰라 남은 작성중 계획이면 LINE_UNKNOWN 과 PLAN_NOT_CONFIRMED 를 함께 낸다', () => {
    expect(attempted(qty(100), [plan({ lineKnown: false })], [])?.reasons).toEqual(['LINE_UNKNOWN', 'PLAN_NOT_CONFIRMED']);
  });

  it('확정분이 모자라면 QTY_REMAINING', () => {
    expect(attempted(qty(100), [plan({ confirmed: true, plannedQty: qty(60) })], [])).toEqual({ status: 'NEEDS_REVIEW', reasons: ['QTY_REMAINING'] });
  });

  it('확정분이 모자라고 작성중 계획도 있으면 둘 다 낸다', () => {
    const plans = [plan({ confirmed: true, plannedQty: qty(60) }), plan({ plannedQty: qty(40) })];
    expect(attempted(qty(100), plans, [])?.reasons).toEqual(['PLAN_NOT_CONFIRMED', 'QTY_REMAINING']);
  });

  it('시도한 적이 없고 계획도 없으면 상태가 없다(null)', () => {
    expect(autoPlanView(qty(100), [], [], false)).toBeNull();
  });

  it('시도한 적이 없어도 확정 계획이 수량을 채우면 DONE 이다', () => {
    expect(autoPlanView(qty(100), [plan({ confirmed: true })], [], false)).toEqual({ status: 'DONE', reasons: [] });
  });

  it('계획이 없고 막는 것도 없으면 사유 없는 NEEDS_REVIEW 다', () => {
    expect(attempted(qty(100), [], [])).toEqual({ status: 'NEEDS_REVIEW', reasons: [] });
  });
});
