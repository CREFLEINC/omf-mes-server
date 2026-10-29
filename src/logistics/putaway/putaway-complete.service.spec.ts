import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService, PostingInput } from '../../core/inventory-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { PutawayCompleteService, PutawayTaskComplete } from './putaway-complete.service';

const TASK = 700;
const DOCK = 20n;
const RACK = 21n;
const WH = 10n;
const DAY = '2026-05-11';
const AT = '2026-05-11T02:00:00.000Z';

type Row = Record<string, unknown>;

/** ⑧ 이 복제할 「입고 원장 라인의 도착 끝점」 — 잠금 조회가 조인해 내리는 모양 그대로다. */
const ledgerEnd = {
  to_warehouse_id: WH,
  to_location_id: DOCK,
  to_quality_status_code: 'NORMAL',
  to_inventory_status_code: 'AVAILABLE',
  ownership_type_code: 'OWNED',
  owner_partner_id: null,
  handling_unit_id: null,
};

function fake(over: Row = {}) {
  const posts: PostingInput[] = [];
  const updates: Row[] = [];
  const task: Row = {
    putaway_task_id: BigInt(TASK),
    putaway_task_no: 'PT-20260511-0001',
    item_id: 30n,
    lot_id: 40n,
    task_qty: new Prisma.Decimal(10),
    uom_id: 5n,
    from_location_id: DOCK,
    status_code: 'PENDING',
    version_no: 1,
    plant_id: 3n,
    warehouse_id: WH,
    receipt_status_code: 'POSTED',
    ...ledgerEnd,
    ...over,
  };

  const tx: Row = {
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join('?').includes('inventory_balance')
        ? [
            {
              legalEntityId: 1n, businessUnitId: 2n, plantId: 3n, warehouseId: WH,
              locationId: task.from_location_id, itemId: 30n, lotKey: 40n, lotId: 40n,
              quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
              ownership_type_code: 'OWNED', owner_partner_id: null,
              available_qty: new Prisma.Decimal(100),
            },
          ]
        : [task],
    // 사람이 나눈 위치도 「창고 전체」도 없는 창고 — 둬도 되는 위치가 비어 어디든 된다.
    location: {
      findUnique: async () => ({ warehouse_id: WH, is_active: true }),
      groupBy: async () => [],
      findMany: async () => [],
    },
    warehouse: {
      findUniqueOrThrow: async () => ({
        business_unit_id: 2n, plant_id: 3n, plant: { legal_entity_id: 1n },
      }),
    },
    inventory_transaction_line: {
      findMany: async () => [{ inventory_transaction_line_id: 88n }],
    },
    putaway_task: {
      update: async (args: Row) => {
        updates.push(args);
        return {
          ...task,
          ...(args.data as Row),
          actual_location_id: (args.data as Row).actual_location_id,
          priority_no: 100, assigned_worker_id: null,
          completed_at: new Date(AT), remarks: null,
          goods_receipt_line: {
            goods_receipt: { warehouse_id: WH, warehouse: { management_level_code: 'LOCATION' } },
          },
        };
      },
    },
  };

  const prisma = {
    worker: { findUnique: async () => ({ worker_id: 1n }) },
    code_value: { findMany: async () => [{ code: 'NO_SPACE', code_group: { group_code: 'PUTAWAY_TASK_TEMPORARY_REASON' } }] },
    $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaService;

  const posting = {
    post: async (_tx: Prisma.TransactionClient, input: PostingInput) => {
      posts.push(input);
      return { inventoryTransactionId: 55n, businessDate: DAY, alreadyPosted: false };
    },
  } as unknown as InventoryPostingService;

  const service = new PutawayCompleteService(prisma, posting, new DocumentStateService());
  return { service, posts, updates };
}

const body = (over: Partial<PutawayTaskComplete> = {}): PutawayTaskComplete => ({
  actualLocationId: Number(RACK),
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});

const context = { workerNo: 'W-001', appUserId: 1 };

const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

const firstError = (error: ContractException): { code: string; field?: string } =>
  (error.getResponse() as { errors: { code: string; field?: string }[] }).errors[0];

describe('적치 완료 :complete · :complete-temporary', () => {
  it('임시 적재는 사유 코드도 비고도 없으면 400 REQUIRED(reasonCode)', async () => {
    const { service, posts } = fake();

    const error = await thrown(() => service.complete(TASK, body(), context, 'TEMPORARY'));

    expect(firstError(error)).toMatchObject({ code: 'REQUIRED', field: 'reasonCode' });
    expect(posts).toEqual([]);
    // 비고만 있어도 통과한다 — 「적어도 하나」다.
    const passing = fake();
    const view = await passing.service.complete(TASK, body({ remarks: '자리 없음' }), context, 'TEMPORARY');
    expect(view.statusCode).toBe('COMPLETED_TEMPORARY');
  });

  it('⭐ 원장의 from 4칸이 입고 라인의 to_* 복제이고 to 는 품질·재고를 그대로 물려받는다', async () => {
    const { service, posts } = fake();

    await service.complete(TASK, body(), context, 'NORMAL');

    const [line] = posts[0].lines;
    expect(line.from).toEqual({
      warehouseId: Number(WH), locationId: Number(DOCK),
      qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE',
    });
    expect(line.to).toEqual({
      warehouseId: Number(WH), locationId: Number(RACK),
      qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE',
    });
    expect(line.ownershipTypeCode).toBe('OWNED');
    // ⚠ 판별자는 `STOCK_TRANSFER` 인데 `sourceDocumentId` 는 적치 지시다(문의 059).
    expect(posts[0]).toMatchObject({
      sourceDocumentTypeCode: 'STOCK_TRANSFER', sourceDocumentId: TASK,
      transactionNo: 'PT-20260511-0001', idempotencyKey: 'PUTAWAY_TASK:PT-20260511-0001',
    });
  });

  it('⭐ 실제 위치가 출발 위치와 같아도 막지 않는다(R-7)', async () => {
    const { service, posts } = fake();

    const view = await service.complete(TASK, body({ actualLocationId: Number(DOCK) }), context, 'NORMAL');

    expect(view.statusCode).toBe('COMPLETED');
    const [line] = posts[0].lines;
    expect(line.from?.locationId).toBe(line.to?.locationId);
  });
});
