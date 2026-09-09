import { allocationWhereSql } from './shipment-allocation-query.service';

/**
 * ⭐ `q` 가 「절이 아니라 `FALSE`」라는 것과 「각 필터가 «독립» 절을 만든다」는 e2e 로도 보이지만,
 * 조립된 SQL 문자열 자체(§6-3 ⑹)는 여기서 직접 본다 — 리뷰가 diff 를 읽을 때 바로 확인되도록.
 */
describe('출하 LOT 배분 목록 질의 조립', () => {
  it('필터가 없으면 TRUE 하나다', () => {
    expect(allocationWhereSql({})).toEqual({ sql: 'TRUE', params: [] });
  });

  it('⭐ q 를 주면 다른 필터와 무관하게 FALSE 로 접는다 — 절이 아니라 상수다(R-8)', () => {
    const built = allocationWhereSql({ q: '아무값', shipmentId: 1 });
    expect(built.sql).toBe('FALSE');
    // q 가 있으면 다른 필터를 바인딩하지 않는다 — 검색이 실제로 실행되지 않는다는 뜻이다.
    expect(built.params).toEqual([]);
  });

  it('네 축이 각각 «독립» 절을 하나씩 늘린다', () => {
    const axes: Partial<Parameters<typeof allocationWhereSql>[0]>[] = [
      { shipmentId: 1 },
      { shipmentLineId: 2 },
      { lotId: 3 },
      { handlingUnitId: 4 },
    ];
    for (const axis of axes) {
      const built = allocationWhereSql(axis);
      expect(built.sql).not.toBe('TRUE');
      expect(built.params).toEqual([Object.values(axis)[0]]);
    }
  });

  it('둘을 함께 주면 AND 로 이어 붙는다', () => {
    const built = allocationWhereSql({ shipmentId: 1, lotId: 3 });
    expect(built.sql).toBe('sl.shipment_id = $1::bigint\n      AND a.lot_id = $2::bigint');
    expect(built.params).toEqual([1, 3]);
  });

  it('unpackedOnly=true 만 IS NULL 절을 만든다 — false 는 절이 없다', () => {
    expect(allocationWhereSql({ unpackedOnly: true }).sql).toBe('a.handling_unit_id IS NULL');
    expect(allocationWhereSql({ unpackedOnly: false })).toEqual({ sql: 'TRUE', params: [] });
  });
});
