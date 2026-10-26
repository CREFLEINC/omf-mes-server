import { goodsReceiptLineWhere } from './goods-receipt-line-list.service';

const TODAY = new Date('2026-10-26T03:00:00Z');

describe('입고 줄 목록의 조건', () => {
  it('상태를 고르지 않으면 취소·취소요청을 뺀다 — 고르면 그 값만 본다', () => {
    const plain = goodsReceiptLineWhere({ receiptDateFrom: '2026-10-01' }, TODAY);
    expect(plain.sql).toContain('gr.status_code <> ALL($2::text[])');
    expect(plain.params[1]).toEqual(['CANCELLED', 'CANCEL_REQUESTED']);

    const cancelled = goodsReceiptLineWhere({ receiptDateFrom: '2026-10-01', statusCode: 'CANCELLED' }, TODAY);
    expect(cancelled.sql).toContain('gr.status_code = $2');
    expect(cancelled.sql).not.toContain('<> ALL');
  });

  it('유형·공장·창고·품목·공급사·검색어를 모두 AND 로 건다', () => {
    const { sql, params } = goodsReceiptLineWhere({
      receiptDateFrom: '2026-10-01', receiptDateTo: '2026-10-26', receiptTypeCode: 'MATERIAL',
      plantId: 1, warehouseId: 2, itemId: 3, supplierId: 4, q: ' GR-1 ',
    }, TODAY);

    expect(sql).toContain('gr.receipt_type_code = $4');
    expect(sql).toContain('gr.plant_id = $5::bigint');
    expect(sql).toContain('gr.warehouse_id = $6::bigint');
    expect(sql).toContain('l.item_id = $7::bigint');
    expect(sql).toContain('ir.supplier_id = $8::bigint');
    expect(sql).toContain('(gr.goods_receipt_no ILIKE $9 OR lt.lot_no ILIKE $9)');
    expect(params).toEqual(['2026-10-01', '2026-10-26', ['CANCELLED', 'CANCEL_REQUESTED'], 'MATERIAL', 1, 2, 3, 4, '%GR-1%']);
  });

  it('기간 시작이 없으면 SQL 을 만들기 전에 400 이다', () => {
    expect(() => goodsReceiptLineWhere({}, TODAY)).toThrow();
  });
});
