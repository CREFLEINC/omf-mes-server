import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { GoodsReceiptCreate, postReceipt } from './receipt-posting';

const input: GoodsReceiptCreate = {
  receiptTypeCode: 'MATERIAL',
  plantId: 1,
  warehouseId: 2,
  receiptDatetime: '2026-09-12T00:00:00.000Z',
  businessDate: '2026-09-12',
  lines: [
    {
      itemId: 3,
      lotId: 4,
      receiptQty: 100,
      uomId: 5,
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
      destinationLocationId: 6,
    },
  ],
};

function fake(workerId: bigint | null) {
  const tasks: Array<Record<string, unknown>> = [];
  const tx = {
    goods_receipt: {
      create: async () => ({ goods_receipt_id: 10n, warehouse_id: 2n }),
    },
    goods_receipt_line: {
      create: async () => ({ goods_receipt_line_id: 20n }),
      update: async () => undefined,
    },
    inventory_transaction_line: {
      findMany: async () => [{ inventory_transaction_line_id: 30n }],
    },
    worker: {
      findFirst: async () => (workerId === null ? null : { worker_id: workerId }),
    },
    putaway_rule: {
      findFirst: async () => ({ putaway_rule_id: 40n, location_id: 7n }),
    },
    putaway_task: {
      create: async ({ data }: { data: Record<string, unknown> }) => void tasks.push(data),
    },
  } as unknown as Prisma.TransactionClient;
  const posting = {
    post: async () => ({ inventoryTransactionId: 50n, businessDate: input.businessDate, alreadyPosted: false }),
  } as unknown as InventoryPostingService;
  return { tx, posting, tasks };
}

describe('입고 적치 지시 배정', () => {
  it('계정 없는 단말 작업자의 지시 귀속은 worker_id이고 app_user 칸은 NULL이다', async () => {
    const { tx, posting, tasks } = fake(null);
    await postReceipt(tx, posting, input, undefined, 'GR-20260912-0002', ['PT-20260912-0002'], 88n);
    expect(tasks[0]).toMatchObject({ assigned_worker_id: 88n, created_by: null });
  });
  it.each([
    { linkedWorkerId: 77n, expected: 77n },
    { linkedWorkerId: null, expected: null },
  ])('입고 처리자 연결 작업자가 $expected 이면 생성 지시에 그대로 반영한다', async ({ linkedWorkerId, expected }) => {
    const { tx, posting, tasks } = fake(linkedWorkerId);

    await postReceipt(tx, posting, input, 9, 'GR-20260912-0001', ['PT-20260912-0001']);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      assigned_worker_id: expected,
      status_code: 'PENDING',
      created_by: 9n,
    });
  });
});
