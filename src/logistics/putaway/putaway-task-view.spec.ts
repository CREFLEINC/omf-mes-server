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
      goods_receipt: { warehouse_id: 61n },
    },
    ...overrides,
  } as TaskRow;
}

describe('taskView', () => {
  it('⭐ warehouseId 는 goods_receipt.warehouse_id 다 — from_location_id 가 아니다', () => {
    const view = taskView(
      row({ from_location_id: 999n, goods_receipt_line: { goods_receipt: { warehouse_id: 61n } } }), [],
    );

    expect(view.warehouseId).toBe(61);
  });

  it('응답에 reasonCode·inventoryTransactionLineId·versionNo 가 없다', () => {
    const view = taskView(row(), []) as unknown as Record<string, unknown>;

    expect(view).not.toHaveProperty('reasonCode');
    expect(view).not.toHaveProperty('inventoryTransactionLineId');
    expect(view).not.toHaveProperty('versionNo');
  });
});

describe('taskView — 창고 보충 수령 원천(피처 004)', () => {
  it('입고 줄이 없으면 창고 = 출발 위치의 창고, originCode = REPLENISHMENT_RECEIPT, 수령 줄 id 를 싣는다', () => {
    const view = taskView(
      row({
        goods_receipt_line_id: null,
        goods_receipt_line: null,
        shopfloor_receipt_line_id: 71n,
        location_putaway_task_from_location_idTolocation: { warehouse_id: 81n },
      }),
      [],
    );

    expect(view).toMatchObject({ warehouseId: 81, goodsReceiptLineId: null, shopfloorReceiptLineId: 71, originCode: 'REPLENISHMENT_RECEIPT' });
  });

  it('입고 원천은 originCode = GOODS_RECEIPT 이고 창고는 그대로 입고 전표의 창고', () => {
    const view = taskView(row({ shopfloor_receipt_line_id: null, location_putaway_task_from_location_idTolocation: { warehouse_id: 999n } }), []);

    expect(view).toMatchObject({ warehouseId: 61, goodsReceiptLineId: 11, shopfloorReceiptLineId: null, originCode: 'GOODS_RECEIPT' });
  });
});
