import { Prisma } from '@prisma/client';

import { InventoryCountCloseService } from './inventory-count-close.service';
import { InventoryCountQueryService } from './inventory-count-query.service';

const DETAIL = {
  inventoryCount: {
    inventoryCountId: 91,
    inventoryCountNo: 'IC-20260909-0001',
    countTypeCode: 'CYCLE',
    warehouseId: 51,
    plannedDate: '2026-09-09',
    blindCount: false,
    statusCode: 'COMPLETED',
  },
  summary: {
    plannedCount: 1,
    countedCount: 1,
    uncountedCount: 0,
    varianceCount: 0,
    closable: false,
    closeBlockedReasonCode: 'ALREADY_CLOSED',
  },
};

describe('재고 실사 마감', () => {
  it('헤더 잠금·필수 버전·공용 차단 판정 뒤 COMPLETED와 버전을 한 번 갱신한다', async () => {
    const { service, tx, queries, events } = fixture();

    await expect(
      service.closeWithin(tx, 91, 4, { businessDate: '2026-09-09' }, 71),
    ).resolves.toEqual(DETAIL);

    expect(events[0]).toBe('lock');
    expect(mockOf(tx.inventory_count_line.count)).toHaveBeenCalledTimes(4);
    expect(mockOf(tx.inventory_count.updateMany)).toHaveBeenCalledWith({
      where: { inventory_count_id: 91n, status_code: 'IN_PROGRESS', version_no: 4 },
      data: { status_code: 'COMPLETED', version_no: { increment: 1 }, updated_by: 71 },
    });
    expect(queries.getWithin).toHaveBeenCalledWith(tx, 91);
  });

  it('낡은 If-Match는 잠금 직후 409이고 마감 조건을 읽지 않는다', async () => {
    const { service, tx } = fixture();

    await expect(
      service.closeWithin(tx, 91, 3, { businessDate: '2026-09-09' }, 71),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.inventory_count_line.count).not.toHaveBeenCalled();
    expect(tx.inventory_count.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['COMPLETED', [1, 0, 0, 0], 'ALREADY_CLOSED'],
    ['PLANNED', [0, 0, 0, 0], 'STATE_LOCKED'],
    ['IN_PROGRESS', [2, 1, 0, 0], 'COUNT_REMAINING'],
    ['IN_PROGRESS', [1, 1, 1, 1], 'VARIANCE_UNADJUSTED'],
  ] as const)(
    '%s 상태와 집계 %j는 우선순위에 따라 %s로 차단한다',
    async (statusCode, counts, code) => {
      const { service, tx } = fixture({ statusCode, counts: [...counts] });

      await expect(
        service.closeWithin(tx, 91, 4, { businessDate: '2026-09-09' }, 71),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          errors: [expect.objectContaining({ field: 'inventoryCountId', code })],
        },
      });
      expect(tx.inventory_count.updateMany).not.toHaveBeenCalled();
    },
  );

  it('잘못된 businessDate는 잠금 전에 INVALID로 거부한다', async () => {
    const { service, tx } = fixture();

    await expect(
      service.closeWithin(tx, 91, 4, { businessDate: 'not-a-date' }, 71),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [expect.objectContaining({ field: 'businessDate', code: 'INVALID' })] },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('조건부 갱신 0행은 저장 충돌 409이고 응답을 만들지 않는다', async () => {
    const { service, tx, queries } = fixture();
    mockOf(tx.inventory_count.updateMany).mockResolvedValue({ count: 0 });

    await expect(
      service.closeWithin(tx, 91, 4, { businessDate: '2026-09-09' }, 71),
    ).rejects.toMatchObject({ status: 409 });
    expect(queries.getWithin).not.toHaveBeenCalled();
  });
});

function fixture(
  options: { statusCode?: string; counts?: number[] } = {},
): {
  service: InventoryCountCloseService;
  tx: Prisma.TransactionClient;
  queries: jest.Mocked<InventoryCountQueryService>;
  events: string[];
} {
  const events: string[] = [];
  const counts = options.counts ?? [1, 1, 0, 0];
  const tx = {
    $queryRaw: jest.fn(async () => {
      events.push('lock');
      return [
        {
          inventory_count_id: 91n,
          status_code: options.statusCode ?? 'IN_PROGRESS',
          version_no: 4,
        },
      ];
    }),
    inventory_count_line: {
      count: jest.fn()
        .mockResolvedValueOnce(counts[0])
        .mockResolvedValueOnce(counts[1])
        .mockResolvedValueOnce(counts[2])
        .mockResolvedValueOnce(counts[3]),
    },
    inventory_count: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as Prisma.TransactionClient;
  const queries = {
    getWithin: jest.fn().mockResolvedValue({ detail: DETAIL, versionNo: 5 }),
  } as unknown as jest.Mocked<InventoryCountQueryService>;
  return { service: new InventoryCountCloseService(queries), tx, queries, events };
}

function mockOf(value: unknown): jest.Mock {
  return value as jest.Mock;
}
