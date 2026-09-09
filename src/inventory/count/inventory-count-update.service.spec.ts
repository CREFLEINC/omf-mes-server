import { Prisma } from '@prisma/client';

import { InventoryCountQueryService } from './inventory-count-query.service';
import {
  InventoryCountLineReplace,
  InventoryCountUpdateService,
} from './inventory-count-update.service';

const NOW = new Date('2026-09-09T03:04:05.000Z');
const RESPONSE = { items: [], page: { page: 1, size: 50, total: 0 } };

describe('위치별 재고 실사 입력', () => {
  it('부모를 먼저 잠그고 기존 갱신·누락 복귀·신규 스냅샷·버전 증가를 한 tx에서 수행한다', async () => {
    const { service, tx, events, queries } = fixture();
    const input = body([
      line({ inventoryCountLineId: 101, countedQty: 10 }),
      line({
        inventoryCountLineId: undefined,
        itemId: 22,
        lotId: 32,
        countedQty: 3,
        varianceReasonCode: 'COUNT_ERROR',
      }),
    ]);

    await expect(
      service.replaceWithin(tx, 91, input, {
        appUserId: 71,
        workerNo: 'W-001',
        version: 4,
      }),
    ).resolves.toEqual(RESPONSE);

    expect(events[0]).toBe('lock');
    expect(mockOf(tx.inventory_count_line.updateMany)).toHaveBeenCalledWith({
      where: { inventory_count_line_id: { in: [102n] } },
      data: {
        counted: false,
        counted_qty: 0,
        variance_reason_code: null,
        counted_by: null,
      },
    });
    expect(mockOf(tx.inventory_count_line.update)).toHaveBeenCalledWith({
      where: { inventory_count_line_id: 101n },
      data: {
        counted_qty: new Prisma.Decimal(10),
        variance_reason_code: null,
        counted_by: 81n,
        counted_at: NOW,
        counted: true,
      },
    });
    expect(mockOf(tx.inventory_count_line.createMany)).toHaveBeenCalledWith({
      data: [
        {
          inventory_count_id: 91n,
          line_no: 8,
          location_id: 11,
          item_id: 22,
          lot_id: 32,
          system_qty: new Prisma.Decimal(5),
          counted_qty: new Prisma.Decimal(3),
          uom_id: 41,
          variance_reason_code: 'COUNT_ERROR',
          counted_by: 81n,
          counted_at: NOW,
          counted: true,
          created_by: 71,
        },
      ],
    });
    expect(mockOf(tx.inventory_count.updateMany)).toHaveBeenCalledWith({
      where: { inventory_count_id: 91n, version_no: 4 },
      data: { status_code: 'IN_PROGRESS', version_no: { increment: 1 }, updated_by: 71 },
    });
    expect(queries.linesWithin).toHaveBeenCalledWith(tx, 91, { locationId: 11 });
  });

  it('If-Match가 없으면 통과하고 사번이 없을 때 세션 사용자를 기록한다', async () => {
    const { service, tx } = fixture({ statusCode: 'IN_PROGRESS' });

    await service.replaceWithin(tx, 91, body([line({ countedQty: 8, varianceReasonCode: 'COUNT_ERROR' })]), {
      appUserId: 71,
    });

    expect(mockOf(tx.inventory_count_line.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ counted_by: 71n }) }),
    );
    expect(tx.worker.findUnique).not.toHaveBeenCalled();
  });

  it('사번에 연결 계정이 없으면 countedBy null을 보존한다', async () => {
    const { service, tx } = fixture();
    mockOf(tx.worker.findUnique).mockResolvedValue({ app_user_id: null });

    await service.replaceWithin(
      tx,
      91,
      body([line({ countedQty: 8, varianceReasonCode: 'COUNT_ERROR' })]),
      { appUserId: 71, workerNo: 'W-NO-ACCOUNT' },
    );

    expect(mockOf(tx.inventory_count_line.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ counted_by: null }) }),
    );
  });

  it('제공한 사번이 없으면 INVALID이고 세션 사용자로 대체하지 않는다', async () => {
    const { service, tx } = fixture();
    mockOf(tx.worker.findUnique).mockResolvedValue(null);

    await expect(
      service.replaceWithin(tx, 91, body([]), {
        appUserId: 71,
        workerNo: 'UNKNOWN',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        errors: [expect.objectContaining({ field: 'X-Worker-No', code: 'INVALID' })],
      },
    });
    expect(tx.inventory_count_line.updateMany).not.toHaveBeenCalled();
  });

  it('낡은 선택 If-Match는 잠금 직후 409이고 어떤 라인도 쓰지 않는다', async () => {
    const { service, tx } = fixture();

    await expect(
      service.replaceWithin(tx, 91, body([]), { appUserId: 71, version: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.location.findUnique).not.toHaveBeenCalled();
    expect(tx.inventory_count_line.updateMany).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'CANCELLED'])('%s 상태는 STATE_LOCKED로 거부한다', async (statusCode) => {
    const { service, tx } = fixture({ statusCode });

    await expect(
      service.replaceWithin(tx, 91, body([]), { appUserId: 71 }),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [expect.objectContaining({ code: 'STATE_LOCKED' })] },
    });
  });

  it('빈 배열은 해당 위치의 기존 라인만 모두 미실사로 되돌린다', async () => {
    const { service, tx, events } = fixture();

    await service.replaceWithin(tx, 91, body([]), { appUserId: 71 });

    expect(mockOf(tx.inventory_count_line.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inventory_count_line_id: { in: [101n, 102n] } } }),
    );
    expect(mockOf(tx.inventory_count_line.update)).not.toHaveBeenCalled();
    expect(mockOf(tx.inventory_count_line.createMany)).not.toHaveBeenCalled();
    expect(events).not.toContain('snapshot');
  });

  it.each([
    [body([line({ locationId: 12 })]), 'locationId', 'INVALID'],
    [body([line(), line({ inventoryCountLineId: 102 })]), 'lines.1', 'UNIQUE_VIOLATION'],
    [
      body([line(), line({ inventoryCountLineId: 101, itemId: 22, lotId: 32 })]),
      'inventoryCountLineId',
      'UNIQUE_VIOLATION',
    ],
  ])('요청 내부 위치·차원·ID 중복을 쓰기 전에 거부한다', async (input, field, code) => {
    const { service, tx } = fixture();
    await expect(
      service.replaceWithin(tx, 91, input as InventoryCountLineReplace, { appUserId: 71 }),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: expect.arrayContaining([expect.objectContaining({ field: expect.stringContaining(String(field)), code })]) },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('기존 라인의 차원을 바꾸거나 다른 위치의 ID를 제출하면 INVALID다', async () => {
    const { service, tx } = fixture();
    await expect(
      service.replaceWithin(tx, 91, body([line({ inventoryCountLineId: 101, itemId: 22, lotId: 32 })]), {
        appUserId: 71,
      }),
    ).rejects.toMatchObject({
      response: { errors: [expect.objectContaining({ field: 'lines.0.inventoryCountLineId', code: 'INVALID' })] },
    });
  });

  it.each([
    [8, undefined, 'REQUIRED'],
    [10, 'COUNT_ERROR', 'INVALID'],
  ])('차이와 사유의 필수 조건을 적용한다', async (countedQty, reason, code) => {
    const { service, tx } = fixture();
    await expect(
      service.replaceWithin(
        tx,
        91,
        body([line({ countedQty, varianceReasonCode: reason })]),
        { appUserId: 71 },
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [expect.objectContaining({ field: 'lines.0.varianceReasonCode', code })] },
    });
  });

  it('신규 차원의 장부가 없으면 systemQty 0이고 음수이면 질의 276 경계로 거부한다', async () => {
    const zero = fixture({ snapshotQty: null });
    await zero.service.replaceWithin(
      zero.tx,
      91,
      body([line({ inventoryCountLineId: undefined, itemId: 22, lotId: 32, countedQty: 0 })]),
      { appUserId: 71 },
    );
    expect(mockOf(zero.tx.inventory_count_line.createMany)).toHaveBeenCalledWith({
      data: [expect.objectContaining({ system_qty: new Prisma.Decimal(0) })],
    });

    const negative = fixture({ snapshotQty: -1 });
    await expect(
      negative.service.replaceWithin(
        negative.tx,
        91,
        body([line({ inventoryCountLineId: undefined, itemId: 22, lotId: 32, countedQty: 0 })]),
        { appUserId: 71 },
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: [expect.objectContaining({ code: 'INVALID' })] },
    });
  });
});

function body(lines: InventoryCountLineReplace['lines']): InventoryCountLineReplace {
  return {
    locationId: 11,
    businessDate: '2026-09-09',
    occurredAt: NOW.toISOString(),
    lines,
  };
}

function line(
  overrides: Partial<InventoryCountLineReplace['lines'][number]> = {},
): InventoryCountLineReplace['lines'][number] {
  return {
    inventoryCountLineId: 101,
    locationId: 11,
    itemId: 21,
    lotId: 31,
    countedQty: 10,
    uomId: 41,
    countedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fixture(options: { statusCode?: string; snapshotQty?: number | null } = {}): {
  service: InventoryCountUpdateService;
  tx: Prisma.TransactionClient;
  queries: jest.Mocked<InventoryCountQueryService>;
  events: string[];
} {
  const events: string[] = [];
  const existing = [
    existingLine(101n, 1, 21n, 31n, 10),
    existingLine(102n, 2, 21n, 31n, 7),
  ];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM inventory.inventory_count\n')) {
        events.push('lock');
        return [
          {
            inventory_count_id: 91n,
            warehouse_id: 51n,
            status_code: options.statusCode ?? 'PLANNED',
            version_no: 4,
          },
        ];
      }
      events.push('snapshot');
      if (options.snapshotQty === null) return [];
      return options.snapshotQty === undefined
        ? [
            { location_id: 11n, item_id: 21n, lot_id: 31n, uom_id: 41n, system_qty: new Prisma.Decimal(10) },
            { location_id: 11n, item_id: 22n, lot_id: 32n, uom_id: 41n, system_qty: new Prisma.Decimal(5) },
          ]
        : [
            {
              location_id: 11n,
              item_id: 22n,
              lot_id: 32n,
              uom_id: 41n,
              system_qty: new Prisma.Decimal(options.snapshotQty),
            },
          ];
    }),
    location: { findUnique: jest.fn().mockResolvedValue({ warehouse_id: 51n }) },
    worker: { findUnique: jest.fn().mockResolvedValue({ app_user_id: 81n }) },
    item: {
      findMany: jest.fn().mockResolvedValue([{ item_id: 21n }, { item_id: 22n }]),
    },
    lot: {
      findMany: jest.fn().mockResolvedValue([
        { lot_id: 31n, item_id: 21n },
        { lot_id: 32n, item_id: 22n },
      ]),
    },
    uom: { findMany: jest.fn().mockResolvedValue([{ uom_id: 41n }]) },
    code_value: {
      findMany: jest.fn().mockResolvedValue([
        { code: 'COUNT_ERROR', code_group: { group_code: 'VARIANCE_REASON' } },
      ]),
    },
    inventory_count_line: {
      findMany: jest.fn().mockResolvedValue(existing),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _max: { line_no: 7 } }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventory_count: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as Prisma.TransactionClient;
  const queries = {
    linesWithin: jest.fn().mockResolvedValue(RESPONSE),
  } as unknown as jest.Mocked<InventoryCountQueryService>;
  return { service: new InventoryCountUpdateService(queries), tx, queries, events };
}

function existingLine(
  id: bigint,
  lineNo: number,
  itemId: bigint,
  lotId: bigint,
  systemQty: number,
): Prisma.inventory_count_lineGetPayload<object> {
  return {
    inventory_count_line_id: id,
    inventory_count_id: 91n,
    line_no: lineNo,
    location_id: 11n,
    item_id: itemId,
    lot_id: lotId,
    system_qty: new Prisma.Decimal(systemQty),
    counted_qty: new Prisma.Decimal(0),
    variance_qty: new Prisma.Decimal(-systemQty),
    uom_id: 41n,
    variance_reason_code: null,
    counted_by: null,
    counted_at: NOW,
    counted: false,
    created_at: NOW,
    created_by: null,
  };
}

function mockOf(value: unknown): jest.Mock {
  return value as jest.Mock;
}
