import { ContractException, ErrorItem } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { OperationHandoverCreate, OperationHandoverService } from './operation-handover.service';

interface StubOptions {
  /** W/O 5(from)·6(to) 의 기본 WIP 위치 — `null` 이면 자리 1 의 400 갈래다. */
  fromWip?: bigint | null;
  toWip?: bigint | null;
}

/** worker 실재 · W/O 5·6 · lot 20·21 · uom 30. */
function stub(options: StubOptions = {}) {
  const created: { header: Record<string, unknown>; lines: Record<string, unknown>[] } = {
    header: {},
    lines: [],
  };

  const prisma = {
    worker: { findUnique: async () => ({ worker_id: 1n }) },
    work_order: {
      findMany: async () => [
        { work_order_id: 5n, default_wip_location_id: options.fromWip === undefined ? 41n : options.fromWip },
        { work_order_id: 6n, default_wip_location_id: options.toWip === undefined ? 42n : options.toWip },
      ],
    },
    lot: { findMany: async () => [{ lot_id: 20n }, { lot_id: 21n }] },
    uom: { findMany: async () => [{ uom_id: 30n }] },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        operation_handover: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.header = data;
            return { operation_handover_id: 801n, ...data };
          },
          findUniqueOrThrow: async () => ({
            operation_handover_id: 801n,
            handover_no: created.header.handover_no,
            from_work_order_id: created.header.from_work_order_id,
            to_work_order_id: created.header.to_work_order_id,
            status_code: created.header.status_code,
            handed_over_at: created.header.handed_over_at,
            received_at: created.header.received_at ?? null,
            operation_handover_line: created.lines.map((row, index) => ({
              operation_handover_line_id: BigInt(index + 1),
              operation_handover_id: 801n,
              line_no: row.line_no,
              source_lot_id: BigInt(row.source_lot_id as number),
              handover_qty: row.handover_qty,
              received_qty: row.received_qty,
              uom_id: BigInt(row.uom_id as number),
            })),
          }),
        },
        operation_handover_line: {
          createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
            created.lines = data;
            return { count: data.length };
          },
        },
      }),
  };

  const numbering = { next: async () => 'OH-20260909-0001' };

  return {
    service: new OperationHandoverService(
      prisma as unknown as PrismaService,
      numbering as unknown as NumberingService,
    ),
    created,
  };
}

function body(overrides: Partial<OperationHandoverCreate> = {}): OperationHandoverCreate {
  return {
    fromWorkOrderId: 5,
    toWorkOrderId: 6,
    handedOverAt: '2026-09-09T04:05:06.000Z',
    lines: [
      { lotId: 20, handoverQty: 12.5, uomId: 30 },
      { lotId: 21, handoverQty: 7.25, uomId: 30 },
    ],
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

describe('공정 인계 확정', () => {
  it('line_no 를 본문 순서로 1..N 매긴다', async () => {
    const { service, created } = stub();

    await service.create(body(), 7, 'W-1');

    expect(created.lines.map((line) => [line.line_no, line.source_lot_id])).toEqual([
      [1, 20],
      [2, 21],
    ]);
  });

  it('⭐ received_qty 를 그 라인의 handoverQty 로 채우고 received_at 을 handedOverAt 으로 찍는다', async () => {
    // 계약이 인계·인수를 «한 행위»로 접었다 — 응답에 안 나오는 칸이라 여기와 e2e 의 DB 단언이 그물이다(R-2).
    const { service, created } = stub();

    await service.create(body(), 7, 'W-1');

    expect(created.lines.map((line) => [line.handover_qty, line.received_qty])).toEqual([
      [12.5, 12.5],
      [7.25, 7.25],
    ]);
    expect(created.header.received_at).toEqual(created.header.handed_over_at);
  });

  it('⭐ 기본 WIP 위치가 NULL 인 W/O 는 400 INVALID 다 — 두 칸을 각 W/O 에서 «따로» 푼다', async () => {
    expect(await errorsOf(stub({ fromWip: null }).service.create(body(), 7, 'W-1'))).toContainEqual(
      expect.objectContaining({ field: 'fromWorkOrderId', code: 'INVALID' }),
    );
    expect(await errorsOf(stub({ toWip: null }).service.create(body(), 7, 'W-1'))).toContainEqual(
      expect.objectContaining({ field: 'toWorkOrderId', code: 'INVALID' }),
    );

    const { service, created } = stub();
    await service.create(body(), 7, 'W-1');
    // 위치 두 칸이 «서로 다른» W/O 에서 온다 — 뒤바뀜을 값이 가른다.
    expect(created.lines.map((line) => [line.source_location_id, line.destination_location_id])).toEqual([
      [41n, 42n],
      [41n, 42n],
    ]);
  });
});
