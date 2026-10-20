import { Prisma } from '@prisma/client';

import {
  ProductionOrderChangeFieldRow,
  changedFieldsOf,
  productionOrderView,
} from './production-order-view';

function changeRow(overrides: Partial<ProductionOrderChangeFieldRow>): ProductionOrderChangeFieldRow {
  return {
    production_order_change_field_id: 1n,
    production_order_id: 1001n,
    field_code: 'ORDER_QTY',
    before_order_qty: null,
    before_due_date: null,
    before_status_code: null,
    before_planned_start_date: null,
    ...overrides,
  };
}

/** 지금 ERP W/O 의 값 — 변경 항목의 «이후» 쪽이다. */
const current = {
  status_code: 'UPDATED',
  order_qty: new Prisma.Decimal(1200),
  planned_start_date: null,
  due_date: null,
};

describe('changedFieldsOf — §5-4 고정 순 · beforeQty 규칙', () => {
  it('⑤ 입력 순서와 무관하게 «수량 → 계획 시작일 → 납기 → 상태» 고정 순으로 낸다', () => {
    const rows = [
      changeRow({ field_code: 'STATUS_CODE', before_status_code: 'RECEIVED' }),
      changeRow({ field_code: 'DUE_DATE', before_due_date: new Date('2026-08-01T00:00:00.000Z') }),
      changeRow({ field_code: 'PLANNED_START_DATE', before_planned_start_date: new Date('2026-07-01T00:00:00.000Z') }),
      changeRow({ field_code: 'ORDER_QTY', before_order_qty: new Prisma.Decimal(1000) }),
    ];
    const statusName = (code: string) => `이름(${code})`;

    const result = changedFieldsOf(
      rows,
      { ...current, due_date: new Date('2026-08-15T00:00:00.000Z') },
      statusName,
    );

    expect(result.map((item) => item.field)).toEqual(['ORDER_QTY', 'PLANNED_START_DATE', 'DUE_DATE', 'STATUS_CODE']);
    expect(result.map((item) => item.label)).toEqual(['수량', '계획 시작일', '납기', '상태']);
  });

  it('⑥ beforeQty 는 ORDER_QTY 에만 값이고 나머지는 null 이다', () => {
    const rows = [
      changeRow({ field_code: 'ORDER_QTY', before_order_qty: new Prisma.Decimal(1000) }),
      changeRow({ field_code: 'DUE_DATE', before_due_date: new Date('2026-08-01T00:00:00.000Z') }),
      changeRow({ field_code: 'STATUS_CODE', before_status_code: 'RECEIVED' }),
    ];

    const result = changedFieldsOf(rows, current, (code) => code);

    expect(result.find((item) => item.field === 'ORDER_QTY')?.beforeQty).toBe(1000);
    expect(result.find((item) => item.field === 'DUE_DATE')?.beforeQty).toBeNull();
    expect(result.find((item) => item.field === 'STATUS_CODE')?.beforeQty).toBeNull();
  });

  it('열거한 네 항목 밖의 field_code 는 담지 않는다', () => {
    const rows = [changeRow({ field_code: 'REMARKS' })];

    const result = changedFieldsOf(rows, current, (code) => code);

    expect(result).toEqual([]);
  });

  it('ERP 계획 시작일 변경은 이전·이후 날짜를 싣는다 — 계약 enum 밖(장부 P-66)', () => {
    const rows = [
      changeRow({
        field_code: 'PLANNED_START_DATE',
        before_planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
      }),
    ];

    const result = changedFieldsOf(
      rows,
      { ...current, planned_start_date: new Date('2026-06-10T00:00:00.000Z') },
      (code) => code,
    );

    expect(result).toEqual([
      { field: 'PLANNED_START_DATE', label: '계획 시작일', beforeText: '2026-06-08', afterText: '2026-06-10', beforeQty: null },
    ]);
  });
});

describe('productionOrderView — §2-3 확인 3칸 키 생략', () => {
  const baseRow = {
    production_order_id: 1001n,
    production_order_no: 'PO24-0001',
    erp_order_no: null,
    parent_production_order_id: null,
    bom_level: 0,
    business_unit_id: 1n,
    plant_id: 1n,
    item_id: 1n,
    order_qty: new Prisma.Decimal(100),
    uom_id: 1n,
    due_date: null,
    status_code: 'RECEIVED',
    remarks: null,
    created_at: new Date(),
    created_by: null,
    updated_at: new Date(),
    updated_by: null,
    version_no: 1,
    last_change_received_at: null,
    erp_operation_no: null,
    erp_storage_location_code: null,
    erp_rework_flag: null,
    planned_start_date: null,
    auto_plan_attempted_at: null,
    auto_plan_running_until: null,
  };

  it('⑦ 확인 이력이 없으면 acknowledgedAt·acknowledgedBy·acknowledgeDecisionCode 키가 생략된다', () => {
    const view = productionOrderView(baseRow, { expandedWorkOrderCount: 0, plannedWorkOrderCount: 0 });

    expect(view).not.toHaveProperty('acknowledgedAt');
    expect(view).not.toHaveProperty('acknowledgedBy');
    expect(view).not.toHaveProperty('acknowledgeDecisionCode');
  });

  it('확인 이력이 있으면 세 칸이 모두 실린다', () => {
    const view = productionOrderView(baseRow, {
      expandedWorkOrderCount: 0,
      plannedWorkOrderCount: 0,
      acknowledgement: { acknowledgedAt: new Date('2026-08-20T00:00:00.000Z'), acknowledgedBy: 5n, acknowledgeDecisionCode: 'APPLY' },
    });

    expect(view.acknowledgedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(view.acknowledgedBy).toBe(5);
    expect(view.acknowledgeDecisionCode).toBe('APPLY');
  });

  it('ERP 원본 칸 넷(계획 시작일·공정번호·창고·재작업)을 싣고, 비면 키를 뺀다 — 장부 P-75', () => {
    const fromErp = productionOrderView(
      {
        ...baseRow,
        planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
        erp_operation_no: '010',
        erp_storage_location_code: 'S110',
        erp_rework_flag: 'N',
      },
      { expandedWorkOrderCount: 0, plannedWorkOrderCount: 0 },
    );
    const fromMes = productionOrderView(baseRow, { expandedWorkOrderCount: 0, plannedWorkOrderCount: 0 });

    expect(fromErp).toMatchObject({
      plannedStartDate: '2026-06-08',
      erpOperationNo: '010',
      erpStorageLocationCode: 'S110',
      erpReworkFlag: 'N',
    });
    for (const key of ['plannedStartDate', 'erpOperationNo', 'erpStorageLocationCode', 'erpReworkFlag']) {
      expect(fromMes).not.toHaveProperty(key);
    }
  });

  it('행이 없어도 파생 두 칸은 0 이다(키 생략이 아니다)', () => {
    const view = productionOrderView(baseRow, { expandedWorkOrderCount: 0, plannedWorkOrderCount: 0 });

    expect(view.expandedWorkOrderCount).toBe(0);
    expect(view.plannedWorkOrderCount).toBe(0);
  });
});
