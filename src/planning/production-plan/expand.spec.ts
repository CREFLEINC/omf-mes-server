import { Prisma } from '@prisma/client';

import { PlanToExpand, dependencyRows, workOrderRows } from './expand';

const plan = (overrides: Partial<PlanToExpand> = {}): PlanToExpand => ({
  productionPlanId: 7,
  statusCode: 'DRAFT',
  itemId: 11n,
  plannedQty: new Prisma.Decimal(40),
  uomId: 3n,
  operationIds: [101n, 102n, 103n],
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
    });
    expect(rows.map((row) => Number(row.order_qty))).toEqual([40, 40, 40]);
    // ⛔ 라인·기본 위치·스냅샷은 칸 자체를 싣지 않는다 — PUT 이 채운다(R-5).
    for (const column of ['production_line_id', 'default_wip_location_id', 'operation_settings_snapshot']) {
      expect(rows[0]).not.toHaveProperty(column);
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
