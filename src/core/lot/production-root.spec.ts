import { Prisma } from '@prisma/client';

import { productionRootOf } from './production-root';

/** 피처 013 R-5 — 제품 분리 자식 LOT 의 W/O 는 분할 뿌리(원천 W/O LOT)에서 푼다. */
describe('productionRootOf', () => {
  const db = (rows: { base_lot_id: bigint; root_lot_id: bigint; work_order_id: bigint }[]) =>
    ({ $queryRaw: jest.fn().mockResolvedValue(rows) }) as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;

  it('US1-2 원천 W/O LOT 은 자기 자신, 자식 -S1·손자 -S1-S1 은 원래 LOT 이 뿌리다', async () => {
    const client = db([
      { base_lot_id: 10n, root_lot_id: 10n, work_order_id: 7n },
      { base_lot_id: 11n, root_lot_id: 10n, work_order_id: 7n },
      { base_lot_id: 12n, root_lot_id: 10n, work_order_id: 7n },
    ]);
    const roots = await productionRootOf(client, [10n, 11n, 12n]);
    expect(roots.get(10n)).toEqual({ rootLotId: 10n, workOrderId: 7n });
    expect(roots.get(11n)).toEqual({ rootLotId: 10n, workOrderId: 7n });
    expect(roots.get(12n)).toEqual({ rootLotId: 10n, workOrderId: 7n });
  });

  it('Q20 008 부분 출고 분할(자재) LOT 은 W/O 뿌리가 없다(null)', async () => {
    const roots = await productionRootOf(db([]), [30n]);
    expect(roots.get(30n)).toBeNull();
  });

  it('여러 LOT 을 쿼리 1회로 푼다 — 사슬은 parent_lot_id 를 타고, 원천 WORK_ORDER 인 가장 가까운 조상을 고른다', async () => {
    const client = db([{ base_lot_id: 11n, root_lot_id: 10n, work_order_id: 7n }]);
    await productionRootOf(client, [11n, 31n, 11n]);
    const query = client.$queryRaw as jest.Mock;
    expect(query).toHaveBeenCalledTimes(1);
    const sql = (query.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('parent_lot_id');
    expect(sql).toContain('WITH RECURSIVE');
  });

  it('빈 목록은 조회하지 않는다', async () => {
    const client = db([]);
    await expect(productionRootOf(client, [])).resolves.toEqual(new Map());
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});
