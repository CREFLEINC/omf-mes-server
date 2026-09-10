import {
  PICKED_ONLY_SQL,
  ShipmentFilters,
  orderBySql,
  whereSql,
} from './shipment-query.sql';

const FROM = '2026-09-01';

/**
 * ⭐ 이 파일이 겨누는 것은 **HTTP 로 반증되지 않는 자리**다(README §6-3 ⑹) — 정렬 2차 키 ·
 * 「이 축은 «안» 건다」 · 공허참 방지 절. e2e 는 행을 보고 이것들은 «문자열»을 본다.
 */
function where(query: Partial<ShipmentFilters> = {}): { sql: string; params: unknown[] } {
  return whereSql({ shipDateFrom: FROM, ...query });
}

describe('출하 목록 SQL', () => {
  it('⛔ shipDateFrom 이 없으면 400 REQUIRED 다 — 계약 400 은 미선언이다(통보 219 ⓐ)', () => {
    expect(() => whereSql({})).toThrow();
    try {
      whereSql({});
    } catch (error) {
      expect((error as { response?: { errors: unknown[] } }).response?.errors).toEqual([
        {
          field: 'shipDateFrom',
          code: 'REQUIRED',
          message: '출하일 시작은 필수입니다.',
          scope: 'field',
        },
      ]);
    }
  });

  it('기간 축은 shipped_at 이고 «공장 로컬» 자정으로 펴며 끝 경계를 «포함»한다', () => {
    const built = where({ shipDateTo: '2026-09-30' });
    expect(built.sql).toContain('s.shipped_at >= (($1::date)::timestamp AT TIME ZONE (SELECT p.timezone_code');
    // ⛔ `<= to` 로 적으면 그 날 자정만 걸려 하루가 통째로 샌다 — timestamptz 칸이다.
    expect(built.sql).toContain('s.shipped_at < (($2::date + 1)::timestamp AT TIME ZONE (SELECT p.timezone_code');
    // ⭐ 시간대는 «출하 행의» 창고에서 푼다 — 요청 하나에 하나로 접으면 공장이 섞인 목록이 갈린다.
    expect(built.sql).toContain('WHERE w.warehouse_id = s.warehouse_id');
    expect(built.params).toEqual([FROM, '2026-09-30']);
  });

  it('⛔ 고객은 shipment 의 칸이 «아니라» 출하작업지시를 타고 간다', () => {
    const built = where({ customerId: 9 });
    expect(built.sql).toContain('logistics.shipment_request r');
    expect(built.sql).toContain('r.customer_id = $2::bigint');
  });

  it('⭐ statusCode 와 unconfirmedOnly 는 AND 로 겹친다 — 한쪽이 이기지 않는다', () => {
    const built = where({ statusCode: 'CONFIRMED', unconfirmedOnly: true });
    expect(built.sql).toContain('s.status_code = $2');
    expect(built.sql).toContain("s.status_code = 'UNCONFIRMED'");
    // 교집합이 0건인 것이 «정답»이다. 한쪽을 이기게 만들면 화면이 결과를 못 믿는다.
  });

  it('계약이 한 방향만 적은 두 축은 false 면 절을 «안 건다»', () => {
    const built = where({ unconfirmedOnly: false, pickedOnly: false });
    expect(built.sql).not.toContain('UNCONFIRMED');
    expect(built.sql).not.toContain('shipment_request_line');
  });

  it('⛔ pickedOnly 는 공허참을 막는 앞 절을 «반드시» 갖는다', () => {
    // 라인 0건이면 `NOT EXISTS(미달 라인)` 만으로는 참이 되어 피킹 0건 출하가 「끝났다」로 섞인다.
    expect(PICKED_ONLY_SQL).toContain('EXISTS (SELECT 1 FROM logistics.shipment_request_line l');
    expect(PICKED_ONLY_SQL).toContain('AND NOT EXISTS');
    // ⭐ 예약 합계는 I-22 의 `shipmentLinePickedSql()` 이 만든다 — 여기서 다시 적지 않는다.
    expect(PICKED_ONLY_SQL).toContain('inventory_reservation');
    expect(where({ pickedOnly: true }).sql).toContain(PICKED_ONLY_SQL);
  });

  it('⛔ q 의 범위는 shipment_no 하나다 — 계약이 닫았다', () => {
    const built = where({ q: 'SH-2026' });
    expect(built.sql).toContain("s.shipment_no ILIKE '%' || $2 || '%'");
    expect(built.sql).not.toContain('customer');
    expect(built.sql).not.toContain('lot');
  });

  it('lotId 는 조인이 아니라 EXISTS 다 — 헤더가 배분 수만큼 중복되면 total 이 부푼다', () => {
    const built = where({ lotId: 77 });
    expect(built.sql).toContain('EXISTS (SELECT 1 FROM logistics.shipment_line sl');
    expect(built.sql).toContain('a.lot_id = $2::bigint');
  });

  it('⭐ 기본 정렬은 경과일 긴 순 + 2차 키다 — NULLS LAST 는 «없다»', () => {
    // ⛔ 2차 키가 없으면 동률 순서가 SQL 표준 미정의라 쪽 경계에서 행이 겹치거나 샌다.
    // ⛔ `NULLS LAST` 를 붙이지 않는다 — 기간이 필수라 NULL 행이 정렬까지 오지 못한다(e2e L-13).
    expect(orderBySql(undefined)).toBe('s.shipped_at ASC, s.shipment_id ASC');
    expect(orderBySql('shippedAt')).toBe('s.shipped_at ASC, s.shipment_id ASC');
    expect(orderBySql('shipmentNo')).toBe('s.shipment_no ASC, s.shipment_id ASC');
  });

  it('⛔ 화이트리스트 밖 정렬 키는 400 INVALID 다 — customerId 는 조인이라 없다', () => {
    expect(() => orderBySql('customerId')).toThrow();
    expect(() => orderBySql('createdAt')).toThrow();
    // 프로토타입 키로 통과하지 않는다(`hasOwnProperty` 로 본다).
    expect(() => orderBySql('constructor')).toThrow();
  });
});
