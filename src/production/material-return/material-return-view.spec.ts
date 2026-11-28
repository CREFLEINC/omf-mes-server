import { materialReturnLineView } from './material-return-view';
import type { MaterialReturnLineRow } from './material-return-view';

function row(over: Partial<MaterialReturnLineRow>): MaterialReturnLineRow {
  return {
    material_return_line_id: 1n, material_return_id: 10n, line_no: 1, item_id: 100n, lot_id: 200n,
    return_qty: '5' as unknown as MaterialReturnLineRow['return_qty'], uom_id: 300n,
    package_opened: true, quality_check_required: true, return_quality_status_code: null, inventory_transaction_line_id: 9n,
    created_at: new Date('2026-11-27T01:00:00.000Z'), created_by: null,
    work_order_id: null, goods_issue_line_id: null, attribution_code: null, destination_location_id: null,
    lot: { lot_no: 'M-LOT-1' }, work_order: null, location: null, putaway_task: [],
    ...over,
  } as MaterialReturnLineRow;
}

describe('materialReturnLineView', () => {
  it('옛 「반출 요청」 줄은 귀속·받은 위치 칸이 없고, 계약에 없는 칸(품질·포장·원장 라인)을 안 낸다', () => {
    expect(Object.keys(materialReturnLineView(row({}))).sort()).toEqual([
      'itemId', 'lotId', 'lotNo', 'materialReturnLineId', 'returnQty', 'uomId',
    ]);
  });

  it('US1-2 반납 입고 줄은 귀속 W/O·근거 출고 라인·받은 위치를 낸다', () => {
    const view = materialReturnLineView(row({
      work_order_id: 7n, goods_issue_line_id: 8n, attribution_code: 'AUTO_LATEST_ISSUE', destination_location_id: 11n,
      work_order: { work_order_no: 'WO-7' }, location: { location_code: 'G-STG', warehouse_id: 12n },
    }), new Set([200n]));
    expect(view).toMatchObject({
      workOrderId: 7, workOrderNo: 'WO-7', goodsIssueLineId: 8, attributionCode: 'AUTO_LATEST_ISSUE',
      destinationLocationId: 11, destinationLocationCode: 'G-STG', destinationWarehouseId: 12, labelUnprinted: true,
    });
  });

  it('US3-3 귀속 없음(NONE_FINALIZED) 줄은 workOrderId·workOrderNo 를 null 로 낸다', () => {
    const view = materialReturnLineView(row({ goods_issue_line_id: 8n, attribution_code: 'NONE_FINALIZED' }));
    expect(view.workOrderId).toBeNull();
    expect(view.workOrderNo).toBeNull();
    expect(view).not.toHaveProperty('labelUnprinted');
  });

  it('US2-2·Q7 적치 대기로 받은 줄은 반납 때 만든 적치 지시 id 를 내고, 위치를 스캔해 받은 줄(US2-1·Q6)은 칸이 없다', () => {
    const staged = materialReturnLineView(row({ attribution_code: 'AUTO_LATEST_ISSUE', putaway_task: [{ putaway_task_id: 42n }] }));
    expect(staged.putawayTaskId).toBe(42);
    expect(materialReturnLineView(row({ attribution_code: 'AUTO_LATEST_ISSUE' }))).not.toHaveProperty('putawayTaskId');
  });
});
