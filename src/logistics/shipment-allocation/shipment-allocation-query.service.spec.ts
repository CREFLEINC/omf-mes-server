import { PrismaService } from '../../prisma/prisma.service';
import { allocationWhereSql, ShipmentAllocationQueryService } from './shipment-allocation-query.service';

describe('출하 LOT 배분 목록 질의 조립', () => {
  it('필터가 없으면 TRUE 하나다', () => {
    expect(allocationWhereSql({})).toEqual({ sql: 'TRUE', params: [] });
  });

  // ⭐ P-25 — 겨냥이 납품라벨 번호에서 «상자 번호»로 옮겨갔다. 납품 라벨의 주인이
  //    배분에서 출하 단위로 가면서 배분이 그 번호를 더 갖지 않는다.
  it('상자 번호만 정확 일치로 찾고 다른 필터와 AND로 결합한다', () => {
    const built = allocationWhereSql({ q: 'HU-20260916-0001', shipmentId: 1 });
    expect(built.params).toEqual(['HU-20260916-0001', 1]);
    expect(built.sql).toContain('hu.handling_unit_no = $1');
    expect(built.sql).toContain('hu.handling_unit_id = a.handling_unit_id');
    expect(built.sql).toContain('AND sl.shipment_id = $2::bigint');
  });

  it('빈 스캔값도 다른 식별자로 치환하지 않는다', () => {
    const built = allocationWhereSql({ q: '' });
    expect(built.params).toEqual(['']);
    expect(built.sql).toContain('hu.handling_unit_no = $1');
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


describe('단말의 납품라벨 조회 범위', () => {
  it('페이지와 total 모두 라벨 정확 일치와 출하 창고 공장 조건을 함께 적용한다', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const prisma = {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('count(*)') ? [{ total: 0 }] : [];
      },
    } as unknown as PrismaService;

    const result = await new ShipmentAllocationQueryService(prisma).list(
      { q: 'HU-20260916-0001', size: 20 }, 7n,
    );

    expect(result.items).toEqual([]);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain('hu.handling_unit_no = $1');
      expect(call.sql).toContain('tw.plant_id = $2::bigint');
      expect(call.params).toEqual(['HU-20260916-0001', 7n]);
      // ⛔ 스캔 축은 부분 일치로 넓히지 않는다 — 하나가 여럿을 물면 다른 물건을 집는다.
      expect(call.sql).not.toContain('ILIKE');
    }
  });
});
