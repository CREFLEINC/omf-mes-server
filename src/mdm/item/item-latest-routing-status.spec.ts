import { PrismaService } from '../../prisma/prisma.service';
import { ItemService } from './item.service';

/** omf-all-around#231 — 품목 목록을 가장 최근 Rev 의 상태로 거른다(공정 경로 관리 진행 상태 칩). */
function harness(latest: { item_id: bigint; status_code: string }[]) {
  const routingFindMany = jest.fn().mockResolvedValue(latest);
  const itemFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    routing: { findMany: routingFindMany },
    item: { findMany: itemFindMany, count: jest.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return { service: new ItemService(prisma), routingFindMany, itemFindMany };
}

const whereOf = (findMany: jest.Mock): Record<string, unknown> =>
  (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;

describe('품목 목록 — 최근 Rev 상태 조건 (omf-all-around#231)', () => {
  it('품목마다 가장 최근 Rev 한 줄을 받아, 그 상태가 같은 품목만 낸다', async () => {
    const { service, routingFindMany, itemFindMany } = harness([
      { item_id: 1n, status_code: 'DRAFT' },
      { item_id: 2n, status_code: 'CONFIRMED' },
      { item_id: 3n, status_code: 'DRAFT' },
    ]);

    await service.list({ latestRoutingStatus: 'DRAFT' });

    expect(routingFindMany).toHaveBeenCalledWith({
      distinct: ['item_id'],
      orderBy: [{ item_id: 'asc' }, { routing_version: 'desc' }],
      select: { item_id: true, status_code: true },
    });
    expect(whereOf(itemFindMany)).toMatchObject({ item_id: { in: [1n, 3n] } });
  });

  it('맞는 품목이 없으면 빈 조건(in: [])으로 아무것도 내지 않는다', async () => {
    const { service, itemFindMany } = harness([{ item_id: 1n, status_code: 'CONFIRMED' }]);

    await service.list({ latestRoutingStatus: 'OBSOLETE' });

    expect(whereOf(itemFindMany)).toMatchObject({ item_id: { in: [] } });
  });

  it('조건이 없으면 Routing 을 조회하지 않고 품목 조건도 걸지 않는다', async () => {
    const { service, routingFindMany, itemFindMany } = harness([]);

    await service.list({});

    expect(routingFindMany).not.toHaveBeenCalled();
    expect(whereOf(itemFindMany)).not.toHaveProperty('item_id');
  });
});
