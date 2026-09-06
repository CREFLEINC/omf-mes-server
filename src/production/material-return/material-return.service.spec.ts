import { ContractException, ErrorItem } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialReturnCreate, MaterialReturnService } from './material-return.service';

interface Created {
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

interface StubOptions {
  /** 출발 위치의 창고가 속한 공장 — 기본은 목적 창고와 같다. */
  locationPlantId?: bigint;
  warehousePlantId?: bigint;
  lotItemId?: bigint;
}

/** W/O 실재 · 위치·창고 둘 다 공장 1 · item 10 · lot 20·21(둘 다 품목 10) · uom 30. */
function stub(options: StubOptions = {}) {
  const created: Created = { header: {}, lines: [] };
  const calls: string[] = [];

  const prisma = {
    work_order: { count: async () => 1 },
    location: {
      findUnique: async () => ({ warehouse: { plant_id: options.locationPlantId ?? 1n } }),
    },
    warehouse: { findUnique: async () => ({ plant_id: options.warehousePlantId ?? 1n }) },
    item: { findMany: async () => [{ item_id: 10n }] },
    lot: {
      findMany: async () => [
        { lot_id: 20n, item_id: options.lotItemId ?? 10n },
        { lot_id: 21n, item_id: options.lotItemId ?? 10n },
      ],
    },
    uom: { findMany: async () => [{ uom_id: 30n }] },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      calls.push('transaction');
      return work({
        material_return: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.header = data;
            return { material_return_id: 701n, ...data };
          },
          findUniqueOrThrow: async () => ({
            material_return_id: 701n,
            material_return_no: created.header.material_return_no,
            work_order_id: created.header.work_order_id,
            source_location_id: created.header.source_location_id,
            destination_warehouse_id: created.header.destination_warehouse_id,
            status_code: created.header.status_code,
            requested_at: created.header.requested_at,
            received_at: created.header.received_at ?? null,
            material_return_line: created.lines.map((row, index) => ({
              material_return_line_id: BigInt(index + 1),
              material_return_id: 701n,
              line_no: row.line_no,
              item_id: BigInt(row.item_id as number),
              lot_id: BigInt(row.lot_id as number),
              return_qty: row.return_qty,
              uom_id: BigInt(row.uom_id as number),
            })),
          }),
        },
        material_return_line: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            created.lines = data;
            return { count: data.length };
          },
        },
      });
    },
  };

  const numbering = {
    next: async () => {
      calls.push('numbering');
      return 'MR-20260907-0001';
    },
  };

  return {
    service: new MaterialReturnService(prisma as unknown as PrismaService, numbering as unknown as NumberingService),
    created,
    calls,
  };
}

function body(overrides: Partial<MaterialReturnCreate> = {}): MaterialReturnCreate {
  return {
    workOrderId: 5,
    sourceLocationId: 9,
    destinationWarehouseId: 7,
    lines: [{ itemId: 10, lotId: 20, returnQty: 5, uomId: 30 }],
    ...overrides,
  };
}

async function errorsOf(work: Promise<unknown>): Promise<ErrorItem[]> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ContractException) return error.errors;
    throw error;
  }
  throw new Error('400 이 나지 않았다');
}

describe('자재 반출 등록', () => {
  it('line_no 를 본문 순서로 1..N 매긴다', async () => {
    // 계약 라인에 `lineNo` 가 없고 물리 `uq_material_return_line` 이 NOT NULL 이다 —
    // 서버가 본문 순서로 매긴다(I-4 `goods_issue_line` 선례).
    const { service, created } = stub();

    await service.create(
      body({
        lines: [
          { itemId: 10, lotId: 21, returnQty: 5, uomId: 30 },
          { itemId: 10, lotId: 20, returnQty: 3, uomId: 30 },
        ],
      }),
      3,
      'W001',
    );

    expect(created.lines.map((line) => [line.line_no, line.lot_id])).toEqual([
      [1, 21],
      [2, 20],
    ]);
  });

  it('본문 안 (itemId, lotId) 중복이면 400 INVALID', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(
        body({
          lines: [
            { itemId: 10, lotId: 20, returnQty: 5, uomId: 30 },
            { itemId: 10, lotId: 20, returnQty: 3, uomId: 30 },
          ],
        }),
        3,
        'W001',
      ),
    );

    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[1].lotId', code: 'INVALID' }));
  });

  it('returnQty 가 0 이하면 400 RANGE', async () => {
    const { service } = stub();

    const errors = await errorsOf(
      service.create(body({ lines: [{ itemId: 10, lotId: 20, returnQty: 0, uomId: 30 }] }), 3, 'W001'),
    );

    expect(errors).toContainEqual(expect.objectContaining({ field: 'lines[0].returnQty', code: 'RANGE' }));
  });

  it('source_location 의 공장과 destination_warehouse 의 공장이 다르면 400 INVALID', async () => {
    // 계약이 시키지 않은 이 슬라이스의 유일한 거부다 — 거부는 완화가 싸다(I-10 R-11).
    const { service } = stub({ locationPlantId: 1n, warehousePlantId: 2n });

    const errors = await errorsOf(service.create(body(), 3, 'W001'));

    expect(errors).toEqual([expect.objectContaining({ field: 'destinationWarehouseId', code: 'INVALID' })]);
  });

  it('return_quality_status_code 를 넣지 않는다', async () => {
    // 설계 미정 — 문의 053
    const { service, created } = stub();

    await service.create(body(), 3, 'W001');

    expect(created.lines[0]).not.toHaveProperty('return_quality_status_code');
  });

  it('package_opened·quality_check_required 를 넣지 않는다(DEFAULT false)', async () => {
    const { service, created } = stub();

    await service.create(body(), 3, 'W001');

    expect(created.lines[0]).not.toHaveProperty('package_opened');
    expect(created.lines[0]).not.toHaveProperty('quality_check_required');
  });

  it('requested_at 을 서버 시각으로 채우고 received_at 은 NULL 로 둔다', async () => {
    // 담을 칸은 있는데 받을 칸이 없다 — 계약 `MaterialReturnCreate` 에 날짜가 0개다(문의 051).
    const before = Date.now();
    const { service, created } = stub();

    await service.create(body(), 3, 'W001');

    const requestedAt = created.header.requested_at as Date;
    expect(requestedAt).toBeInstanceOf(Date);
    expect(requestedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(created.header).not.toHaveProperty('received_at');
    expect(created.header.status_code).toBe('REQUESTED');
  });

  it('⛔ InventoryPostingService 를 부르지 않는다', async () => {
    // 설계 미정 — 문의 051
    // 「안 불렀다」를 세는 대신 **생성자 의존성에 그 서비스가 없음**을 단언한다 — 나중에
    // 누가 주입하면 이 테스트가 먼저 깨진다(원장 행은 불변이라 되돌릴 수 없다 · §4-4).
    expect(MaterialReturnService.length).toBe(2);
    const { service, created, calls } = stub();

    await service.create(body(), 3, 'W001');

    expect(created.lines[0]).not.toHaveProperty('inventory_transaction_line_id');
    // 번호는 `$transaction` 을 열기 전에 뽑는다(I-2 R-2).
    expect(calls).toEqual(['numbering', 'transaction']);
  });

  it('X-Worker-No 가 없으면 400 REQUIRED 이고 저장하지 않는다', async () => {
    const { service, created, calls } = stub();

    const errors = await errorsOf(service.create(body(), 3, undefined));

    expect(errors).toEqual([expect.objectContaining({ field: 'X-Worker-No', code: 'REQUIRED' })]);
    expect(created.header).toEqual({});
    expect(calls).toEqual([]);
  });
});
