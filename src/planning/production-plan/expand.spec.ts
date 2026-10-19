import { Prisma } from '@prisma/client';

import { PlanToExpand, dependencyRows, workOrderRows } from './expand';

const plan = (overrides: Partial<PlanToExpand> = {}): PlanToExpand => ({
  productionPlanId: 7,
  statusCode: 'DRAFT',
  itemId: 11n,
  plannedQty: new Prisma.Decimal(40),
  uomId: 3n,
  operationIds: [101n, 102n, 103n],
  window: { plannedStartAt: new Date('2026-11-20T00:00:00.000Z'), plannedEndAt: new Date('2026-11-21T00:00:00.000Z') },
  line: { productionLineId: null, defaultWipLocationId: null, defaultFgLocationId: null, defaultScrapLocationId: null },
  dependencies: [],
  ...overrides,
});

const dependency = (predecessor: bigint, successor: bigint, dependencyTypeCode = 'FINISH_TO_START') => ({
  predecessor_operation_id: predecessor,
  successor_operation_id: successor,
  dependency_type_code: dependencyTypeCode,
});

describe('expand — 계획 확정 전개 조립(순수)', () => {
  it('① 공정 N 이면 W/O 가 N 벌이고 칸이 §3-3 표대로 채워진다', () => {
    const rows = workOrderRows(plan(), ['WO-A', 'WO-B', 'WO-C'], 9);

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      work_order_no: 'WO-B',
      production_plan_id: 7n,
      routing_operation_id: 102n,
      item_id: 11n,
      uom_id: 3n,
      work_order_type_code: 'NORMAL',
      priority_no: 100,
      status_code: 'PLANNED',
      created_by: 9,
      updated_by: 9,
      planned_start_at: new Date('2026-11-20T00:00:00.000Z'),
      planned_end_at: new Date('2026-11-21T00:00:00.000Z'),
    });
    expect(rows.map((row) => Number(row.order_qty))).toEqual([40, 40, 40]);
    // 교대는 정하지 않는다 — 현장이 4M 에서 고른다.
    expect(rows[0]).not.toHaveProperty('planned_shift_id');
    // 라인·기본 위치는 계획 라인에서 온다(여기선 비어 있다). 스냅샷은 칸 자체를 싣지 않는다 — `:release` 가 뜬다.
    expect(rows[0]).toMatchObject({ production_line_id: null, default_wip_location_id: null, default_fg_location_id: null, default_scrap_location_id: null });
    for (const column of ['operation_settings_snapshot']) {
      expect(rows[0]).not.toHaveProperty(column);
    }
  });

  it('계획 라인이 있으면 라인과 기본 위치 셋을 전개분 전부에 싣는다', () => {
    const line = { productionLineId: 21n, defaultWipLocationId: 31n, defaultFgLocationId: 32n, defaultScrapLocationId: null };
    const rows = workOrderRows(plan({ line }), ['WO-A', 'WO-B', 'WO-C'], 9);

    for (const row of rows) {
      expect(row).toMatchObject({ production_line_id: 21n, default_wip_location_id: 31n, default_fg_location_id: 32n, default_scrap_location_id: null });
    }
  });

  it('② 의존은 반환 순서가 아니라 공정 id map 으로 짝짓는다(R-7)', () => {
    // `createManyAndReturn` 이 뒤섞어 돌려줘도 결과가 같아야 한다 — 일부러 역순 map 이다.
    const workOrderIdOf = new Map([
      [103n, 900n],
      [102n, 901n],
      [101n, 902n],
    ]);

    const rows = dependencyRows(
      plan({ dependencies: [dependency(101n, 102n), dependency(102n, 103n, 'START_TO_START')] }),
      workOrderIdOf,
      9,
    );

    expect(rows).toEqual([
      {
        predecessor_work_order_id: 902n,
        successor_work_order_id: 901n,
        dependency_type_code: 'FINISH_TO_START',
        required_qty_rule_code: 'AVAILABLE_GOOD_QTY',
        created_by: 9,
      },
      {
        predecessor_work_order_id: 901n,
        successor_work_order_id: 900n,
        dependency_type_code: 'START_TO_START',
        required_qty_rule_code: 'AVAILABLE_GOOD_QTY',
        created_by: 9,
      },
    ]);
  });

  it('③ 의존이 0건이면 빈 배열이다 — 전개는 그대로 성공한다(§3-4)', () => {
    expect(dependencyRows(plan(), new Map(), 9)).toEqual([]);
  });
});
