import { orderBySql, whereSql } from './shipment-request-query.sql';

/**
 * ⭐⭐ **e2e 가 «구조적으로» 못 보는 두 축**을 이 spec 이 본다(README §6-3 ⑹).
 *
 * ⓐ **정렬 2차 키** — 동률 행의 순서는 SQL 표준이 «미정의»다. Postgres 가 우연히 PK 순서를
 *   내주면 「쪽이 안 겹친다」 e2e 는 2차 키를 지워도 초록이다(실측: 물리 순서를 갱신으로
 *   흔들어도 그대로였다). ⇒ ORDER BY 문자열을 **통째로** 대조한다.
 * ⓑ **「이 축은 «안» 건다」** — `statusCode` 처럼 절이 «없어야» 하는 축은 목록 결과가 안 좁혀지는
 *   것으로만 보이고, 그것은 픽스처에 그 값의 행이 «전부» 있을 때에만 산다. ⇒ 조립 결과를 통째로
 *   대조한다(`toEqual`) — 절 하나가 늘거나 줄면 그 자리에서 깨진다.
 */
describe('출하작업지시 목록 질의 조립', () => {
  const FROM = { shipDateFrom: '2026-08-13' };

  describe('orderBySql', () => {
    it('기본은 출하일 오름차순이고 2차 키가 PK 오름차순이다', () => {
      // ⛔ 2차 키를 빼거나 방향을 뒤집으면 여기서 깨진다 — e2e 는 그것을 못 본다.
      expect(orderBySql(undefined)).toBe(
        'sr.requested_ship_date ASC, sr.shipment_request_id ASC',
      );
    });

    it('허용 3키가 각각 «제» 컬럼을 내고 2차 키를 함께 단다', () => {
      expect(orderBySql('requestedShipDate')).toBe(orderBySql(undefined));
      expect(orderBySql('customerId')).toBe('sr.customer_id ASC, sr.shipment_request_id ASC');
      expect(orderBySql('shipmentRequestNo')).toBe(
        'sr.shipment_request_no ASC, sr.shipment_request_id ASC',
      );
    });

    it('그 밖의 정렬 축은 400 INVALID 다 — 화이트리스트 밖이다', () => {
      expect(() => orderBySql('allocatedQty')).toThrow();
      // 프로토타입 칸이 화이트리스트를 뚫지 않는다.
      expect(() => orderBySql('constructor')).toThrow();
      expect(() => orderBySql('toString')).toThrow();
    });
  });

  describe('whereSql', () => {
    const base = whereSql(FROM);

    it('shipDateFrom 이 없으면 400 REQUIRED 다 — 목록도 요약도 같은 게이트다', () => {
      expect(() => whereSql({})).toThrow();
    });

    it('shipDateFrom 하나면 절도 하나 · 파라미터도 하나다', () => {
      expect(base.params).toEqual(['2026-08-13']);
      expect(base.sql).toBe('sr.requested_ship_date >= $1::date');
    });

    it('⛔ statusCode 는 절을 «만들지 않는다» — 계약이 닫은 칸이다', () => {
      // 목록 결과로만 보면 「그 값의 행이 픽스처에 전부 있을 때」에만 반증된다 — 여기서 직접 본다.
      expect(whereSql({ ...FROM, statusCode: 'REGISTERED' })).toEqual(base);
    });

    it('나머지 9축은 «각각» 절을 하나씩 늘린다', () => {
      const axes: Partial<Parameters<typeof whereSql>[0]>[] = [
        { shipDateTo: '2026-08-14' },
        { customerId: 1 },
        { shipToPartnerId: 2 },
        { timeSlotCode: 'MORNING' },
        { itemId: 3 },
        { shippingInspectionRequired: true },
        { shipmentProgressCode: 'PICKED' },
        { pickingCompleteOnly: true },
        { shippableRemainderOnly: true },
      ];

      for (const axis of axes) {
        const built = whereSql({ ...FROM, ...axis });
        expect(built.sql.startsWith(`${base.sql}\n      AND `)).toBe(true);
        expect(built.sql).not.toBe(base.sql);
      }
      // 파생 축 둘은 상수 술어라 바인딩이 «안» 는다 — 값을 싣는 축과 갈린다.
      expect(whereSql({ ...FROM, pickingCompleteOnly: true }).params).toEqual(['2026-08-13']);
      expect(whereSql({ ...FROM, itemId: 3 }).params).toEqual(['2026-08-13', 3]);
      expect(whereSql({ ...FROM, shipDateTo: '2026-08-14' }).params).toEqual([
        '2026-08-13',
        '2026-08-14',
      ]);
    });

    it('`false` 인 파생 축 둘은 절을 안 만든다 — 계약이 한 방향만 적었다', () => {
      expect(whereSql({ ...FROM, pickingCompleteOnly: false })).toEqual(base);
      expect(whereSql({ ...FROM, shippableRemainderOnly: false })).toEqual(base);
      // ⚠ `shippingInspectionRequired` 는 «다르다» — `false` 도 진짜 필터다.
      expect(whereSql({ ...FROM, shippingInspectionRequired: false })).not.toEqual(base);
    });

    it('진행 축은 ③a 의 CASE 를 «그대로» 편다 — 여기서 다시 적지 않는다', () => {
      const built = whereSql({ ...FROM, shipmentProgressCode: 'NOT_ALLOCATED' });

      // ⛔ ③a 가 못박은 별칭 집합이다 — 어긋나면 Postgres 42703 으로 500 이다.
      expect(built.sql).toContain("WHEN t.allocated_qty = 0 THEN 'NOT_ALLOCATED'");
      expect(built.sql).toContain("ELSE 'PARTIALLY_ALLOCATED'");
    });
  });
});
