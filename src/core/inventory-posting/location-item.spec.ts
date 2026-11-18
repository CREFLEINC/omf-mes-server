import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertAllowedItems } from './location-item';
import { PostingLine } from './posting.types';

/** 「지정 품목만 받기」(피처 009 · 2026-11-18 결정) — 켠 위치만 지정 밖 품목을 막는다. */
const to = (locationId: number) => ({ warehouseId: 1, locationId, qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE' });
const line = (itemId: number, locationId: number, from?: number): PostingLine =>
  ({ itemId, qty: 1, uomId: 1, ownershipTypeCode: 'OWNED', to: to(locationId), ...(from === undefined ? {} : { from: to(from) }) }) as PostingLine;

function db(restricted: { location_id: bigint; items: number[] }[]) {
  const calls: unknown[] = [];
  const tx = {
    location: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return restricted.map((row) => ({ location_id: row.location_id, location_item: row.items.map((item) => ({ item_id: BigInt(item) })) }));
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'location'>;
  return { tx, calls };
}

describe('assertAllowedItems — 「지정 품목만 받기」 켠 위치만', () => {
  it('FR-017b 켠 위치가 없으면 지정 여부와 상관없이 통과한다(질의는 켠 위치만 찾는다)', async () => {
    const { tx, calls } = db([]);
    await expect(assertAllowedItems(tx, [line(7, 10)])).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ where: { item_restricted: true } });
  });

  it('FR-017d 켠 위치에 지정 밖 품목이면 400 LOCATION_ITEM_RESTRICTED, 지정 품목이면 통과', async () => {
    const error = await assertAllowedItems(db([{ location_id: 10n, items: [8] }]).tx, [line(7, 10)]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors).toEqual([expect.objectContaining({ code: 'LOCATION_ITEM_RESTRICTED', message: '이 위치는 지정 품목만 받습니다.' })]);
    await expect(assertAllowedItems(db([{ location_id: 10n, items: [7, 8] }]).tx, [line(7, 10)])).resolves.toBeUndefined();
  });

  it('같은 위치 안 상태 변경은 보지 않는다', async () => {
    const { tx, calls } = db([{ location_id: 10n, items: [8] }]);
    await expect(assertAllowedItems(tx, [line(7, 10, 10)])).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
