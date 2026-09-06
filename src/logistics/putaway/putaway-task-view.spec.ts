import { TaskRow, taskView } from './putaway-task-view';

function row(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    putaway_task_id: 1n,
    putaway_task_no: 'PT-20260511-0001',
    goods_receipt_line_id: 11n,
    item_id: 21n,
    lot_id: 31n,
    task_qty: 10 as unknown as TaskRow['task_qty'],
    uom_id: 41n,
    from_location_id: 51n,
    recommended_location_id: null,
    applied_putaway_rule_id: null,
    actual_location_id: null,
    priority_no: 100,
    assigned_worker_id: null,
    status_code: 'PENDING',
    completed_at: null,
    inventory_transaction_line_id: 91n,
    remarks: null,
    reason_code: null,
    version_no: 1,
    goods_receipt_line: {
      goods_receipt: { warehouse_id: 61n, warehouse: { management_level_code: 'RACK' } },
    },
    ...overrides,
  } as TaskRow;
}

describe('taskView', () => {
  it('⭐ warehouseId 는 goods_receipt.warehouse_id 다 — from_location_id 가 아니다', () => {
    const view = taskView(
      row({ from_location_id: 999n, goods_receipt_line: { goods_receipt: { warehouse_id: 61n, warehouse: { management_level_code: 'ZONE' } } } }),
    );

    expect(view.warehouseId).toBe(61);
    expect(view.warehouseManagementLevelCode).toBe('ZONE');
  });

  it('응답에 reasonCode·inventoryTransactionLineId·versionNo 가 없다', () => {
    const view = taskView(row()) as unknown as Record<string, unknown>;

    expect(view).not.toHaveProperty('reasonCode');
    expect(view).not.toHaveProperty('inventoryTransactionLineId');
    expect(view).not.toHaveProperty('versionNo');
  });
});
