import { Prisma } from '@prisma/client';

import { ResourcePlanRow, WorkOrderRow, workOrderResourcePlanView, workOrderView } from './work-order-view';

function workOrderRow(overrides: Partial<WorkOrderRow> = {}): WorkOrderRow {
  return {
    work_order_id: 7n,
    work_order_no: 'WO-2026-0001',
    production_plan_id: null,
    routing_operation_id: 11n,
    item_id: 12n,
    order_qty: new Prisma.Decimal(100),
    uom_id: 13n,
    work_order_type_code: 'NORMAL',
    parent_work_order_id: null,
    rework_source_work_order_id: null,
    rework_source_lot_id: null,
    rework_source_nonconformance_id: null,
    production_line_id: null,
    responsible_worker_id: null,
    planned_start_at: null,
    planned_end_at: null,
    planned_equipment_id: null,
    planned_mold_id: null,
    planned_shift_id: null,
    priority_no: 100,
    default_wip_location_id: null,
    default_fg_location_id: null,
    default_scrap_location_id: null,
    operation_settings_snapshot: null,
    status_code: 'PLANNED',
    released_at: null,
    completed_at: null,
    completion_variance_reason_code: null,
    closed_at: null,
    remarks: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_by: null,
    version_no: 3,
    close_disposition_code: null,
    cancellation_reason_code: null,
    po_mismatch: false,
    production_plan: null,
    routing_operation: { operation_name: '사출' },
    item: { item_code: 'ITM-0001' },
    ...overrides,
  };
}

function resourcePlanRow(overrides: Partial<ResourcePlanRow>): ResourcePlanRow {
  return {
    work_order_resource_assignment_id: 1n,
    work_order_id: 7n,
    resource_type_code: 'EQUIPMENT',
    equipment_id: null,
    mold_id: null,
    worker_id: null,
    shift_id: null,
    planned_start_at: null,
    planned_end_at: null,
    assignment_status_code: 'PLANNED',
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_by: null,
    version_no: 1,
    ...overrides,
  };
}

describe('WorkOrder 뷰', () => {
  it('뷰 — 값 없는 칸은 키를 생략한다(널을 안 보낸다)', () => {
    const view = workOrderView(workOrderRow(), { erpMessageQueued: false });

    // 널 칸은 키 자체가 없다 — `undefined` 로 「있는데 값이 없다」와 뜻이 갈리지 않게 한다.
    for (const key of ['productionPlanId', 'plannedStartAt', 'remarks', 'closedAt', 'validation']) {
      expect(Object.keys(view)).not.toContain(key);
    }
    // 마감 전 `erpMessageQueued` 는 널·false 가 아니라 «키 없음»이다(계약 ⌜마감 전에는 비어 있다⌝).
    expect(Object.keys(view)).not.toContain('erpMessageQueued');
    // 값이 있는 칸은 0·false 여도 그대로 낸다.
    expect(view).toMatchObject({ workOrderId: 7, poMismatch: false, versionNo: 3, itemCode: 'ITM-0001' });
  });

  it('뷰 — 표시용 파생 넷은 계획 → P/O 조인으로 낸다', () => {
    const view = workOrderView(
      workOrderRow({
        production_plan_id: 21n,
        production_plan: { production_order_id: 31n, production_order: { production_order_no: 'PO-2026-0001' } },
      }),
      { erpMessageQueued: true },
    );

    expect(view).toMatchObject({
      productionPlanId: 21,
      productionOrderId: 31,
      productionOrderNo: 'PO-2026-0001',
      routingOperationName: '사출',
      itemCode: 'ITM-0001',
      erpMessageQueued: true,
    });
  });

  it('뷰 — 저장된 기본 위치 세 칸을 API 필드로 그대로 낸다', () => {
    const view = workOrderView(
      workOrderRow({
        default_wip_location_id: 101n,
        default_fg_location_id: 102n,
        default_scrap_location_id: 103n,
      }),
      { erpMessageQueued: false },
    );

    expect(view).toMatchObject({
      defaultWipLocationId: 101,
      defaultFgLocationId: 102,
      defaultScrapLocationId: 103,
    });
  });

  it('뷰 — resourceId 는 resource_type_code 로 갈라 읽는다(COALESCE 가 아니다)', () => {
    // 판별자와 다른 칸이 함께 차 있어도 판별자가 가리키는 칸만 읽는다.
    const worker = workOrderResourcePlanView(
      resourcePlanRow({ resource_type_code: 'WORKER', worker_id: 55n }),
    );
    const mold = workOrderResourcePlanView(resourcePlanRow({ resource_type_code: 'MOLD', mold_id: 66n }));
    // 계약 enum 밖(`SHIFT`)은 물리에 행이 있을 수 있다 — COALESCE 였다면 shift_id 를 resourceId
    // 로 조용히 냈을 자리다. 키를 생략하고 유형 문자열은 그대로 낸다.
    const shift = workOrderResourcePlanView(resourcePlanRow({ resource_type_code: 'SHIFT', shift_id: 77n }));

    expect(worker.resourceId).toBe(55);
    expect(mold.resourceId).toBe(66);
    expect(shift.resourceTypeCode).toBe('SHIFT');
    expect(Object.keys(shift)).not.toContain('resourceId');
  });
});
