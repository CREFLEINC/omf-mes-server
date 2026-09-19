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

function fake() {
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

// omf-all-around#26 — 적치에 담당자를 두지 않는다(2026-09-19 사용자 결정). 누가 입고하든
// 지시는 미배정으로 생기고, 모바일은 단말 공장의 대기 지시를 담당자 없이 읽는다.
describe('입고 적치 지시 배정', () => {
  it('처리 계정과 무관하게 적치 지시를 담당자 없이 만든다', async () => {
    const { tx, posting, tasks } = fake();

    await postReceipt(tx, posting, input, 9, 'GR-20260912-0001', ['PT-20260912-0001']);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      assigned_worker_id: null,
      status_code: 'PENDING',
      created_by: 9n,
    });
  });

  it('계정 없는 단말 입고도 지시는 담당자 없이 만들고 app_user 칸은 NULL이다', async () => {
    const { tx, posting, tasks } = fake();

    await postReceipt(tx, posting, input, undefined, 'GR-20260912-0002', ['PT-20260912-0002']);

    expect(tasks[0]).toMatchObject({ assigned_worker_id: null, created_by: null });
  });
});
