import { shipmentLineWhere } from './shipment-line-list.service';

const TODAY = '2026-10-26';

describe('출하 줄 목록의 조건', () => {
  it('기간은 출하 창고 공장의 현지 날짜로 shipped_at 에 건다', () => {
    const { sql } = shipmentLineWhere({ shipDateFrom: '2026-10-01' }, TODAY);
    expect(sql).toContain('s.shipped_at >= (($1::date)::timestamp AT TIME ZONE p.timezone_code)');
  });

  it('상태를 고르지 않으면 취소된 출하를 뺀다 — 고르면 그 값만 본다', () => {
    expect(shipmentLineWhere({ shipDateFrom: '2026-10-01' }, TODAY).sql).toContain('s.status_code <> $2');
    const cancelled = shipmentLineWhere({ shipDateFrom: '2026-10-01', statusCode: 'CANCELLED' }, TODAY);
    expect(cancelled.sql).toContain('s.status_code = $2');
    expect(cancelled.params[1]).toBe('CANCELLED');
  });

  it('공장·창고·품목·고객·검색어(출하 번호 또는 LOT 번호)를 AND 로 건다', () => {
    const { sql, params } = shipmentLineWhere({
      shipDateFrom: '2026-10-01', plantId: 1, warehouseId: 2, itemId: 3, customerId: 4, q: 'LOT-9',
    }, TODAY);

    expect(sql).toContain('w.plant_id = $3::bigint');
    expect(sql).toContain('s.warehouse_id = $4::bigint');
    expect(sql).toContain('sl.item_id = $5::bigint');
    expect(sql).toContain('sr.customer_id = $6::bigint');
    expect(sql).toContain('s.shipment_no ILIKE $7');
    expect(sql).toContain('ql.lot_no ILIKE $7');
    expect(params).toEqual(['2026-10-01', 'CANCELLED', 1, 2, 3, 4, '%LOT-9%']);
  });
});
