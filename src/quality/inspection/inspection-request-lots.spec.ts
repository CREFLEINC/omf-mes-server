import type { Prisma } from '@prisma/client';

import { requestLotIds } from './inspection-request-lots';

/** 피처 005 R-9 — 「요청의 LOT 들」(D2-2). */
describe('requestLotIds', () => {
  function tx(lots: bigint[]) {
    const findMany = jest.fn().mockResolvedValue(lots.map((lot_id) => ({ lot_id })));
    return { client: { lot: { findMany } } as unknown as Prisma.TransactionClient, findMany };
  }

  it('D2-2 lot_id 가 있으면 그 LOT 하나 — 옛 IQC·PQC·OQC 행', async () => {
    const { client, findMany } = tx([]);

    await expect(requestLotIds(client, { lot_id: 7n, inbound_lot_id: null })).resolves.toEqual([7n]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('D2-2 이전된 옛 요청은 입하 LOT 이 있어도 lot_id 하나 — 옛 선별 자식을 끌어오지 않는다', async () => {
    const { client, findMany } = tx([7n, 8n]);

    await expect(requestLotIds(client, { lot_id: 7n, inbound_lot_id: 3n })).resolves.toEqual([7n]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('D2-2 lot_id 가 없으면 입하 LOT 의 자재 관리 LOT 전부(분할 자식 포함) — LOT 순서대로', async () => {
    const { client, findMany } = tx([11n, 12n, 15n]);

    await expect(requestLotIds(client, { lot_id: null, inbound_lot_id: 3n })).resolves.toEqual([11n, 12n, 15n]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inbound_lot_id: 3n }, orderBy: { lot_id: 'asc' } }),
    );
  });

  it('D2-2 둘 다 없으면 빈 목록 — W/O 대상 PQC·헤더 대상 OQC', async () => {
    const { client, findMany } = tx([]);

    await expect(requestLotIds(client, { lot_id: null, inbound_lot_id: null })).resolves.toEqual([]);
    await expect(requestLotIds(client, { lot_id: null })).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
