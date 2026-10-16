import { Prisma } from '@prisma/client';

import { splitLotWithin } from './lot-split';

/** omf-all-around#108 — 처분 선별의 LOT 분할(장부 P-53). */
describe('splitLotWithin', () => {
  const tx = (siblings: number) => {
    const created: Record<string, unknown>[] = [];
    const relations: Record<string, unknown>[] = [];
    const client = {
      lot: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          lot_no: 'LOT-1', item_id: 7n, lot_type_code: 'PRODUCTION', plant_id: 3n, uom_id: 1n,
          status_code: 'INSPECTION_PENDING', manufactured_at: null, expiry_date: null, bom_id: null,
        }),
        count: jest.fn().mockResolvedValue(siblings),
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
    parentLotId: 10n, qty: new Prisma.Decimal(30), sourceEventTypeCode: 'DISPOSITION_DECISION',
    sourceEventId: 5n, occurredAt: new Date('2026-10-16T00:00:00Z'), createdBy: 9n,
  };

  it('원 LOT 의 상태·품목으로 자식을 만들고 계보를 남긴다', async () => {
    const { client, created, relations } = tx(0);
    await expect(splitLotWithin(client, input)).resolves.toEqual({ lotId: 91n, lotNo: 'LOT-1-S1' });
    expect(created[0]).toMatchObject({
      lot_no: 'LOT-1-S1', item_id: 7n, plant_id: 3n, status_code: 'INSPECTION_PENDING',
      source_type_code: 'LOT_SPLIT', source_id: 10n, parent_lot_id: 10n,
    });
    expect(relations[0]).toMatchObject({
      source_lot_id: 10n, target_lot_id: 91n, relation_type_code: 'SPLIT',
      source_event_type_code: 'DISPOSITION_DECISION', source_event_id: 5n,
    });
  });

  it('같은 원 LOT 의 다음 분할은 번호가 하나씩 는다', async () => {
    const { client } = tx(2);
    await expect(splitLotWithin(client, input)).resolves.toMatchObject({ lotNo: 'LOT-1-S3' });
  });
});
