import { Prisma } from '@prisma/client';

import {
  categoryOf,
  basisHash,
  blockIssue,
  plansToPropose,
  proposedPlanDate,
  reasonsOf,
  statusOf,
  warnIssue,
} from './proposal-policy';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

describe('plansToPropose — 무엇을 제안하는가', () => {
  it('작성중 계획을 이어서 하면 그것만 검토한다 — 남은 수량이 있어도 새 계획을 더 제안하지 않는다', () => {
    expect(plansToPropose(['draft'], D(100), D(20), 'CONTINUE')).toEqual({ kind: 'REVIEW_DRAFT', drafts: ['draft'] });
  });

  it('작성중 계획이 있어도 이어서가 아니면 대체할 새 계획 하나 — 수량은 확정 계획량만 뺀다', () => {
    const choice = plansToPropose(['draft'], D(100), D(20), 'REPLACE');
    expect(choice.kind === 'NEW_PLAN' && choice.qty.toNumber()).toBe(80);
  });

  it('없으면 확정 계획량을 뺀 수량으로 새 계획 하나', () => {
    const choice = plansToPropose([], D(100), D(30), 'CONTINUE');
    expect(choice.kind).toBe('NEW_PLAN');
    expect(choice.kind === 'NEW_PLAN' && choice.qty.toNumber()).toBe(70);
  });
});

describe('categoryOf — 입고 창고 연결 실패는 위치를 골라도 풀리지 않는다', () => {
  it('연결 실패 넷은 BLOCKED, 다른 창고 위치(고르면 풀린다)와 빈 위치는 INPUT', () => {
    for (const code of ['FG_WAREHOUSE_UNMAPPED', 'FG_WAREHOUSE_INACTIVE', 'FG_WAREHOUSE_OTHER_PLANT', 'FG_WAREHOUSE_NOT_ALLOWED'] as const) {
      expect(categoryOf(code)).toBe('BLOCKED');
    }
    expect(categoryOf('FG_LOCATION_OUTSIDE_WAREHOUSE')).toBe('INPUT');
    expect(categoryOf('WORK_ORDER_LOCATION_REQUIRED')).toBe('INPUT');
  });

  it('BLOCKED 사유여도 상태는 NEEDS_INPUT 이다', () => {
    const reasons = reasonsOf([blockIssue('FG_WAREHOUSE_UNMAPPED', 'm', 'defaultFgLocationId')]);
    expect(reasons).toEqual([{ code: 'FG_WAREHOUSE_UNMAPPED', category: 'BLOCKED' }]);
    expect(statusOf('NEW_PLAN', false, reasons)).toBe('NEEDS_INPUT');
  });
});

describe('reasonsOf · statusOf — 사유 분류와 상태', () => {
  it('BLOCK 코드를 한 번씩 정해진 순서로, 분류와 함께 낸다 — WARN 은 사유가 아니다', () => {
    const issues = [
      blockIssue('WORK_ORDER_LOCATION_REQUIRED', 'm', 'defaultWipLocationId'),
      blockIssue('WORK_ORDER_LINE_REQUIRED', 'm', 'productionLineId'),
      blockIssue('WORK_ORDER_LOCATION_REQUIRED', 'm', 'defaultFgLocationId'),
      blockIssue('BOM_DEFAULT_REQUIRED', 'm'),
      warnIssue('MOLD_LIFE_EXCEEDED', 'm', 'plannedMoldId'),
    ];
    expect(reasonsOf(issues)).toEqual([
      { code: 'BOM_DEFAULT_REQUIRED', category: 'BLOCKED' },
      { code: 'WORK_ORDER_LINE_REQUIRED', category: 'INPUT' },
      { code: 'WORK_ORDER_LOCATION_REQUIRED', category: 'INPUT' },
    ]);
  });

  it('사유가 없으면 확정 가능, 있으면 보완 필요, 유지·취소는 변경 없음', () => {
    expect(statusOf('NEW_PLAN', false, [])).toBe('CONFIRMABLE');
    expect(statusOf('REVIEW_DRAFT', false, [{ code: 'PLAN_QTY_EXCEEDS_ORDER', category: 'INPUT' }])).toBe('NEEDS_INPUT');
    expect(statusOf('NOT_PROPOSABLE', false, [{ code: 'ROUTING_REQUIRED', category: 'BLOCKED' }])).toBe('NEEDS_INPUT');
    expect(statusOf('KEEP_CONFIRMED', false, [])).toBe('NO_CHANGE');
    // 확정분이 채웠어도 작성중 계획이 남으면 사람이 치워야 한다.
    expect(statusOf('KEEP_CONFIRMED', false, [{ code: 'DRAFT_PLAN_EXCEEDS_ORDER', category: 'BLOCKED' }])).toBe('NEEDS_INPUT');
    expect(statusOf('NOT_PROPOSABLE', true, [{ code: 'ORDER_CANCELLED', category: 'BLOCKED' }])).toBe('NO_CHANGE');
  });

  it('OA 자동 W/O 공장은 실행기가 처리하므로 변경 없음이다', () => {
    expect(statusOf('AUTO_WORK_ORDER', false, [])).toBe('NO_CHANGE');
  });
});

describe('basisHash · proposedPlanDate', () => {
  it('같은 내용이면 같은 값, 하나라도 다르면 다른 값 — bigint·Decimal 도 견준다', () => {
    expect(basisHash([1n, D(10), 'A'])).toBe(basisHash([1n, D(10), 'A']));
    expect(basisHash([1n, D(10), 'A'])).not.toBe(basisHash([1n, D(10.5), 'A']));
    expect(basisHash([1n, D(10), 'A'])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('계획일은 ERP 계획 시작일이 오늘 이후면 그날, 없거나 지났으면 오늘', () => {
    expect(proposedPlanDate('2026-11-10', '2026-11-05')).toBe('2026-11-10');
    expect(proposedPlanDate('2026-11-05', '2026-11-05')).toBe('2026-11-05');
    expect(proposedPlanDate('2026-11-01', '2026-11-05')).toBe('2026-11-05');
    expect(proposedPlanDate(null, '2026-11-05')).toBe('2026-11-05');
  });
});
