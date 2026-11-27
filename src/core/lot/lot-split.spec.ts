import { Prisma } from '@prisma/client';

import { splitLotWithin } from './lot-split';

/** 피처 008 — 부분 출고의 LOT 분할(R-4). */
describe('splitLotWithin', () => {
  const ROOT = 'A|1000|260731|S|0001';
  const tx = (relatives: string[]) => {
    const created: Record<string, unknown>[] = [];
    const relations: Record<string, unknown>[] = [];
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      lot: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          lot_no: ROOT, item_id: 7n, lot_type_code: 'MATERIAL', plant_id: 3n, uom_id: 1n,
          status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE', manufactured_at: null,
          expiry_date: new Date('2027-01-01T00:00:00Z'), bom_id: null, bom_version: null,
        }),
        findMany: jest.fn().mockResolvedValue(relatives.map((lot_no) => ({ lot_no }))),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { lot_id: 91n, lot_no: data.lot_no };
        }),
      },
      lot_relation: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => relations.push(data)) },
    } as unknown as Prisma.TransactionClient;
    return { client, created, relations };
  };
  const input = {
    parentLotId: 10n, qty: new Prisma.Decimal(300), sourceTypeCode: 'GOODS_ISSUE_SPLIT', sourceId: 55n,
    sourceEventTypeCode: 'GOODS_ISSUE_LINE', sourceEventId: 55n, occurredAt: new Date('2026-11-17T00:00:00Z'), createdBy: 9n,
  };

  it('US1-2·US1-4 원천은 인자, 상태·생애·유효기한은 부모, 입하 LOT 은 비우고 SPLIT 계보를 남긴다', async () => {
    const { client, created, relations } = tx([ROOT]);
    await expect(splitLotWithin(client, input)).resolves.toEqual({ lotId: 91n, lotNo: 'A|300|260731|S|0001-S1' });
    expect(created[0]).toMatchObject({
      lot_no: 'A|300|260731|S|0001-S1', item_id: 7n, plant_id: 3n, initial_qty: input.qty,
      status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE', expiry_date: new Date('2027-01-01T00:00:00Z'),
      source_type_code: 'GOODS_ISSUE_SPLIT', source_id: 55n, parent_lot_id: 10n, bom_id: null, bom_version: null,
    });
    expect(created[0]).not.toHaveProperty('inbound_lot_id');
    expect(relations[0]).toMatchObject({
      source_lot_id: 10n, target_lot_id: 91n, relation_type_code: 'SPLIT', relation_qty: input.qty,
      source_event_type_code: 'GOODS_ISSUE_LINE', source_event_id: 55n, allocation_method_code: 'EXACT',
    });
  });

  it('US1-5 차례는 같은 가족의 -S 최댓값 + 1 이다 — 잠금을 잡은 뒤 센다', async () => {
    const { client } = tx([ROOT, 'A|300|260731|S|0001-S1', 'A|200|260731|S|0001-S3']);
    await expect(splitLotWithin(client, input)).resolves.toMatchObject({ lotNo: 'A|300|260731|S|0001-S4' });
    const lock = (client.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
    const read = ((client.lot.findMany as unknown) as jest.Mock).mock.invocationCallOrder[0];
    expect(lock).toBeLessThan(read);
  });
});
