import { shopfloorReceiptLineView, shopfloorReceiptView } from './shopfloor-receipt-view';
import type { ShopfloorReceiptLineRow, ShopfloorReceiptRow } from './shopfloor-receipt-view';

function baseLine(overrides: Partial<ShopfloorReceiptLineRow> = {}): ShopfloorReceiptLineRow {
  return {
    shopfloor_receipt_line_id: 1n,
    shopfloor_receipt_id: 10n,
    goods_issue_line_id: 100n,
    item_id: 1000n,
    lot_id: 2000n,
    issued_qty: '50' as unknown as ShopfloorReceiptLineRow['issued_qty'],
    received_qty: '50' as unknown as ShopfloorReceiptLineRow['received_qty'],
    variance_qty: '0' as unknown as ShopfloorReceiptLineRow['variance_qty'],
    uom_id: 3000n,
    variance_reason_code: null,
    created_at: new Date('2026-08-06T09:00:00.000Z'),
    created_by: null,
    item: { item_code: 'IT-1', item_name: '품목' },
    lot: { lot_no: 'LOT-1' },
    ...overrides,
  } as ShopfloorReceiptLineRow;
}

describe('shopfloorReceiptLineView', () => {
  it('varianceQty 가 널이면 0 으로 낸다(GENERATED 라 도달 불가)', () => {
    const line = baseLine({ variance_qty: null as unknown as ShopfloorReceiptLineRow['variance_qty'] });
    expect(shopfloorReceiptLineView(line).varianceQty).toBe(0);
  });

  it('varianceReasonCode 가 널이어도 키를 생략하지 않는다', () => {
    const view = shopfloorReceiptLineView(baseLine());
    expect(view).toHaveProperty('varianceReasonCode', null);
  });
});

describe('shopfloorReceiptView', () => {
  it('receivedBy 가 널이어도 키를 생략하지 않는다', () => {
    const row = {
      shopfloor_receipt_id: 10n,
      shopfloor_receipt_no: 'SR-20260806-0001',
      goods_issue_id: 1n,
      work_order_id: 2n,
      destination_location_id: 3n,
      received_at: new Date('2026-08-06T09:00:00.000Z'),
      received_by: null,
      status_code: 'REGISTERED',
      created_at: new Date('2026-08-06T09:00:00.000Z'),
      created_by: null,
      updated_at: new Date('2026-08-06T09:00:00.000Z'),
      updated_by: null,
      version_no: 1,
      shopfloor_receipt_line: [baseLine()],
    } as unknown as ShopfloorReceiptRow;

    const view = shopfloorReceiptView(row);
    expect(view).toHaveProperty('receivedBy', null);
    expect(view.lines).toHaveLength(1);
  });
});
