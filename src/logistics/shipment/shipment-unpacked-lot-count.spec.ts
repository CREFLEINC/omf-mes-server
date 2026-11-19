import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentQueryService } from './shipment-query.service';

/** 목록 질의를 흉내 내는 최소 스텁 — 미포장 배분 수 질의만 행을 돌려주고 나머지는 비운다. */
function stub(unpacked: { shipment_id: bigint; count: number }[]) {
  const rawSql: string[] = [];
  const prisma = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('count(*)::int AS total')) return [{ total: 2 }];
      if (sql.includes('GROUP BY 1')) return [];
      return [{ shipment_id: 11n }, { shipment_id: 12n }];
    },
    $queryRaw: async (query: Prisma.Sql) => {
      rawSql.push(query.sql);
      return query.sql.includes('a.handling_unit_id IS NULL') ? unpacked : [];
    },
    shipment: {
      findMany: async () =>
        [11n, 12n].map((shipment_id) => ({
          shipment_id,
          shipment_no: `SH-${String(shipment_id)}`,
          shipment_request_id: 22n,
          warehouse_id: 33n,
          loaded_at: null,
          shipped_at: null,
          status_code: 'UNCONFIRMED',
          erp_delivery_no: null,
          expedited: false,
          expedite_reason: null,
          version_no: 1,
        })),
    },
    goods_issue: { findMany: async () => [] },
  };
  return { service: new ShipmentQueryService(prisma as unknown as PrismaService), rawSql };
}

describe('출하 목록 unpackedLotCount (omf-all-around#329)', () => {
  it('출하마다 아직 포장하지 않은 배분 수를 싣고, 없는 출하는 0 이다', async () => {
    const { service } = stub([{ shipment_id: 11n, count: 3 }]);
    const result = await service.list({ shipDateFrom: '2026-11-19' });
    expect(result.items.map((item) => [item.shipmentId, item.unpackedLotCount])).toEqual([
      [11, 3],
      [12, 0],
    ]);
  });

  it('⭐ 배분 목록 unpackedOnly 와 같은 기준이고, 출하 전체를 «한 질의»로 센다', async () => {
    const { service, rawSql } = stub([]);
    await service.list({ shipDateFrom: '2026-11-19' });
    const counted = rawSql.filter((sql) => sql.includes('a.handling_unit_id IS NULL'));
    expect(counted).toHaveLength(1);
    expect(counted[0]).toContain('GROUP BY sl.shipment_id');
  });
});
