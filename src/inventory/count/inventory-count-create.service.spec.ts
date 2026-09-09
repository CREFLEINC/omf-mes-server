import { Prisma } from '@prisma/client';

import { IdempotencyContext, IdempotencyService } from '../../common/idempotency';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryCountCreateService,
  snapshotOf,
} from './inventory-count-create.service';
import { InventoryCountQueryService } from './inventory-count-query.service';

const INPUT = {
  countTypeCode: 'CYCLE',
  warehouseId: 41,
  plannedDate: '2026-09-10',
  blindCount: true,
};
const CONTEXT: IdempotencyContext & { appUserId: number } = {
  key: 'inventory-count-create-unit',
  fingerprint: 'fingerprint',
  successStatus: 201,
  appUserId: 71,
};
const RESULT = {
  detail: {
    inventoryCount: {
      inventoryCountId: 91,
      inventoryCountNo: 'IC-20260910-0001',
      countTypeCode: 'CYCLE',
      warehouseId: 41,
      plannedDate: '2026-09-10',
      blindCount: true,
      statusCode: 'IN_PROGRESS',
    },
    summary: {
      plannedCount: 2,
      countedCount: 0,
      uncountedCount: 2,
      varianceCount: 0,
      closable: false,
      closeBlockedReasonCode: 'COUNT_REMAINING',
    },
  },
  versionNo: 1,
};

describe('재고 실사 생성', () => {
  it('멱등 재생이면 검증·채번·스냅샷을 다시 하지 않는다', async () => {
    const { service, prisma, numbering, idempotency } = fixture();
    idempotency.replayExisting = jest.fn().mockResolvedValue({
      replayed: true,
      status: 201,
      body: RESULT,
    });

    await expect(service.create(INPUT, CONTEXT)).resolves.toEqual(RESULT);
    expect(prisma.code_value.findMany).not.toHaveBeenCalled();
    expect(numbering.next).not.toHaveBeenCalled();
    expect(idempotency.run).not.toHaveBeenCalled();
  });

  it('창고의 현재 잔액을 네 축으로 스냅샷하고 미실사 라인을 순서대로 만든다', async () => {
    const { service, tx, numbering, queries } = fixture();

    await expect(service.create(INPUT, CONTEXT)).resolves.toEqual(RESULT);

    expect(numbering.next).toHaveBeenCalledWith('INVENTORY_COUNT', 31n, '2026-09-10');
    expect(tx.inventory_count.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventory_count_no: 'IC-20260910-0001',
        count_type_code: 'CYCLE',
        warehouse_id: 41n,
        planned_date: new Date('2026-09-10T00:00:00.000Z'),
        blind_count: true,
        status_code: 'IN_PROGRESS',
        created_by: 71,
        updated_by: 71,
        inventory_count_line: {
          create: [
            expect.objectContaining({
              line_no: 1,
              location_id: 1n,
              item_id: 2n,
              lot_id: null,
              uom_id: 3n,
              system_qty: new Prisma.Decimal(10),
              counted_qty: 0,
              counted: false,
              created_by: 71,
            }),
          ],
        },
      }),
      select: { inventory_count_id: true },
    });
    expect(queries.getWithin).toHaveBeenCalledWith(tx, 91);
  });

  it('실사번호 유일 충돌만 새 번호로 세 번까지 다시 시도한다', async () => {
    const { service, tx, numbering, idempotency } = fixture();
    numbering.next = jest
      .fn()
      .mockResolvedValueOnce('IC-20260910-0001')
      .mockResolvedValueOnce('IC-20260910-0002');
    idempotency.run = jest
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['inventory_count_no'] },
        }),
      )
      .mockImplementationOnce(async (_context, work) => ({
        replayed: false,
        status: 201,
        body: await work(tx),
      }));

    await expect(service.create(INPUT, CONTEXT)).resolves.toEqual(RESULT);
    expect(numbering.next).toHaveBeenCalledTimes(2);
  });

  it('없는 창고는 채번 전에 400 INVALID로 막는다', async () => {
    const { service, prisma, numbering } = fixture();
    prisma.warehouse.findUnique = jest.fn().mockResolvedValue(null);

    await expect(service.create(INPUT, CONTEXT)).rejects.toMatchObject({
      status: 400,
      response: {
        errors: [expect.objectContaining({ field: 'warehouseId', code: 'INVALID' })],
      },
    });
    expect(numbering.next).not.toHaveBeenCalled();
  });

  it('음수 장부는 값을 자르거나 누락하지 않고 질의 276 회신 전까지 생성 전체를 막는다', async () => {
    const { service, tx } = fixture();
    tx.$queryRaw = jest.fn().mockResolvedValue([
      {
        location_id: 4n,
        item_id: 5n,
        lot_id: 6n,
        uom_id: 3n,
        system_qty: new Prisma.Decimal(-2),
      },
    ]);

    await expect(service.create(INPUT, CONTEXT)).rejects.toMatchObject({
      status: 400,
      response: {
        errors: [expect.objectContaining({ field: 'warehouseId', code: 'INVALID' })],
      },
    });
    expect(tx.inventory_count.create).not.toHaveBeenCalled();
  });

  it('스냅샷 SQL은 네 축 합계·0 제외·결정적 순서를 한 문장으로 고정한다', async () => {
    let sql = '';
    let values: unknown[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        sql = strings.join('?').replace(/\s+/g, ' ').trim();
        values = parameters;
        return [];
      },
    } as unknown as Prisma.TransactionClient;

    await expect(snapshotOf(tx, 41n)).resolves.toEqual([]);
    expect(sql).toContain('SUM(on_hand_qty) AS system_qty');
    expect(sql).toContain('GROUP BY location_id, item_id, lot_id, uom_id');
    expect(sql).not.toContain('quality_status_code');
    expect(sql).not.toContain('inventory_status_code');
    expect(sql).not.toContain('ownership_type_code');
    expect(sql).toContain('HAVING SUM(on_hand_qty) <> 0');
    expect(sql).toContain(
      'ORDER BY location_id ASC, item_id ASC, lot_id ASC NULLS FIRST, uom_id ASC',
    );
    expect(values).toEqual([41n]);
  });
});

function fixture(): {
  service: InventoryCountCreateService;
  prisma: jest.Mocked<PrismaService>;
  tx: Prisma.TransactionClient;
  numbering: jest.Mocked<NumberingService>;
  queries: jest.Mocked<InventoryCountQueryService>;
  idempotency: jest.Mocked<IdempotencyService>;
} {
  const prisma = {
    code_value: {
      findMany: jest.fn().mockResolvedValue([
        { code: 'CYCLE', code_group: { group_code: 'INVENTORY_COUNT_TYPE' } },
      ]),
    },
    warehouse: {
      findUnique: jest.fn().mockResolvedValue({ warehouse_id: 41n, plant_id: 31n }),
    },
  } as unknown as jest.Mocked<PrismaService>;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      { location_id: 1n, item_id: 2n, lot_id: null, uom_id: 3n, system_qty: new Prisma.Decimal(10) },
    ]),
    inventory_count: {
      create: jest.fn().mockResolvedValue({ inventory_count_id: 91n }),
    },
  } as unknown as Prisma.TransactionClient;
  const numbering = {
    next: jest.fn().mockResolvedValue('IC-20260910-0001'),
  } as unknown as jest.Mocked<NumberingService>;
  const queries = {
    getWithin: jest.fn().mockResolvedValue(RESULT),
  } as unknown as jest.Mocked<InventoryCountQueryService>;
  const idempotency = {
    replayExisting: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockImplementation(async (context, work) => ({
      replayed: false,
      status: context.successStatus,
      body: await work(tx),
    })),
  } as unknown as jest.Mocked<IdempotencyService>;
  return {
    service: new InventoryCountCreateService(prisma, queries, numbering, idempotency),
    prisma,
    tx,
    numbering,
    queries,
    idempotency,
  };
}
