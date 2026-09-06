import { materialConsumptionView } from './material-consumption-view';
import type { MaterialConsumptionRow } from './material-consumption-view';

function baseRow(overrides: Partial<MaterialConsumptionRow> = {}): MaterialConsumptionRow {
  return {
    material_consumption_id: 1n,
    consumption_no: 'MC-20260907-0001',
    work_order_id: 10n,
    work_session_id: null,
    shopfloor_receipt_line_id: null,
    bom_component_id: null,
    item_id: 100n,
    lot_id: 200n,
    consumption_type_code: 'NORMAL',
    corrects_consumption_id: null,
    replaced_consumption_id: null,
    change_reason_code: null,
    actual_use_process_id: null,
    input_qty: '120' as unknown as MaterialConsumptionRow['input_qty'],
    actual_consumed_qty: '0' as unknown as MaterialConsumptionRow['actual_consumed_qty'],
    uom_id: 300n,
    entered_qty: null,
    entered_uom_id: null,
    occurred_at: new Date('2026-09-07T01:00:00.000Z'),
    recorded_at: new Date('2026-09-07T01:00:01.000Z'),
    late_entry_reason_code: null,
    worker_id: 400n,
    terminal_id: null,
    status_code: 'RECORDED',
    idempotency_key: 'MCVIEW-1',
    remarks: null,
    created_at: new Date('2026-09-07T01:00:01.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-07T01:00:01.000Z'),
    updated_by: null,
    version_no: 1,
    ...overrides,
  } as MaterialConsumptionRow;
}

describe('materialConsumptionView', () => {
  it('terminalId 가 NULL 이면 키를 생략한다', () => {
    // 설계 미정 — 문의 054(계약 required 인데 단말 토큰 검증 축이 0건이라 물리 칸이 늘 NULL 이다).
    expect(materialConsumptionView(baseRow())).not.toHaveProperty('terminalId');
    // 값이 «있으면» 그대로 싣는다 — 완화가 키를 영구히 지우는 것이 아니다(A→C 후속 한 줄).
    expect(materialConsumptionView(baseRow({ terminal_id: 7n }))).toHaveProperty('terminalId', 7);
  });

  it('actualConsumedQty 를 0 으로 낸다', () => {
    // DEFAULT 0 을 올리는 오퍼레이션이 계약에 0건이라 오늘은 언제나 0 이다(I-10 §3-6).
    // required 라 «값이 0 이어도» 키가 남는다(`omitEmpty` 는 undefined 만 거른다).
    expect(materialConsumptionView(baseRow()).actualConsumedQty).toBe(0);
  });
});
