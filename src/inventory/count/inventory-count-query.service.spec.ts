import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryCountQueryService,
  blockedReason,
  inventoryCountLineWhere,
  inventoryCountSummary,
  inventoryCountWhere,
} from './inventory-count-query.service';

describe('재고 실사 조회 규칙', () => {
  it('목록 필터 전건이 자기 컬럼으로 가고 날짜 양끝은 포함한다', () => {
    expect(
      inventoryCountWhere({
        warehouseId: '7',
        plannedDateFrom: '2026-09-01',
        plannedDateTo: '2026-09-30',
        countTypeCode: 'CYCLE',
        statusCode: 'COMPLETED',
        inProgressOnly: 'true',
      }),
    ).toEqual({
      warehouse_id: 7,
      count_type_code: 'CYCLE',
      status_code: 'COMPLETED',
      AND: [{ status_code: 'IN_PROGRESS' }],
      planned_date: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T00:00:00.000Z'),
      },
    });
  });

  it('라인 필터는 미실사와 차이를 counted 축으로 각각 좁힌다', () => {
    expect(
      inventoryCountLineWhere(9n, {
        locationId: '17',
        itemId: 27,
        uncountedOnly: true,
        varianceOnly: 'true',
      }),
    ).toEqual({
      inventory_count_id: 9n,
      location_id: 17,
      item_id: 27,
      AND: [{ counted: false }, { counted: true, variance_qty: { not: 0 } }],
    });
  });

  it.each([
    ['COMPLETED', 4, 3, 'ALREADY_CLOSED'],
    ['PLANNED', 4, 3, 'STATE_LOCKED'],
    ['IN_PROGRESS', 4, 3, 'COUNT_REMAINING'],
    ['IN_PROGRESS', 0, 3, 'VARIANCE_UNADJUSTED'],
    ['IN_PROGRESS', 0, 0, null],
  ])('마감 사유 우선순위 — %s/%i/%i → %s', (status, uncounted, unadjusted, expected) => {
    expect(blockedReason(status, uncounted, unadjusted)).toBe(expected);
  });

  it('요약은 전체·계수·차이·POSTED 미연결 차이를 따로 세고 한 판정을 쓴다', async () => {
    const calls: unknown[] = [];
    const counts = [5, 4, 2, 1];
    const prisma = {
      inventory_count_line: {
        count: async (input: unknown) => {
          calls.push(input);
          return counts[calls.length - 1];
        },
      },
    } as unknown as Prisma.TransactionClient;

    await expect(inventoryCountSummary(prisma, 19n, 'IN_PROGRESS')).resolves.toEqual({
      plannedCount: 5,
      countedCount: 4,
      uncountedCount: 1,
      varianceCount: 2,
      closable: false,
      closeBlockedReasonCode: 'COUNT_REMAINING',
    });
    expect(calls[3]).toEqual({
      where: {
        inventory_count_id: 19n,
        counted: true,
        variance_qty: { not: 0 },
        inventory_adjustment_line: {
          none: { inventory_adjustment: { status_code: 'POSTED' } },
        },
      },
    });
  });

  it('목록 정렬은 계획일과 PK 모두 내림차순이고 페이지 경계를 적용한다', async () => {
    let find: Record<string, unknown> | undefined;
    const prisma = {
      inventory_count: {
        findMany: async (input: Record<string, unknown>) => {
          find = input;
          return [];
        },
        count: async () => 0,
      },
    } as unknown as PrismaService;
    const service = new InventoryCountQueryService(prisma);

    await expect(service.list({ page: 2, size: 3 })).resolves.toEqual({
      items: [],
      page: { page: 2, size: 3, total: 0 },
    });
    expect(find).toMatchObject({
      orderBy: [{ planned_date: 'desc' }, { inventory_count_id: 'desc' }],
      skip: 3,
      take: 3,
    });
  });
});
