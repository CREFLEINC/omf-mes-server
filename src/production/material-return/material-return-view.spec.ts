import { materialReturnLineView } from './material-return-view';
import type { MaterialReturnLineRow } from './material-return-view';

describe('materialReturnLineView', () => {
  it('MaterialReturnLine 이 계약에 없는 칸(returnQualityStatusCode·packageOpened)을 안 내보낸다', () => {
    const line = {
      material_return_line_id: 1n,
      material_return_id: 10n,
      line_no: 1,
      item_id: 100n,
      lot_id: 200n,
      return_qty: '5' as unknown as MaterialReturnLineRow['return_qty'],
      uom_id: 300n,
      package_opened: true,
      quality_check_required: true,
      // M-2 로 nullable 이 된 칸 — 계약에 자리가 없어 서버가 값을 만들지 않는다(문의 053).
      return_quality_status_code: null,
      inventory_transaction_line_id: null,
      created_at: new Date('2026-09-07T01:00:00.000Z'),
      created_by: null,
    } as unknown as MaterialReturnLineRow;

    // 계약 `MaterialReturnLine` 은 required 4 + 선택 `materialReturnLineId` 다 — 그 다섯뿐이다.
    expect(Object.keys(materialReturnLineView(line)).sort()).toEqual([
      'itemId',
      'lotId',
      'materialReturnLineId',
      'returnQty',
      'uomId',
    ]);
  });
});
