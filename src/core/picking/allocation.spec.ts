import { Prisma } from '@prisma/client';

import { PickingDemand, StockCandidate, allocatePicking } from './allocation';

const D = (value: number) => new Prisma.Decimal(value);
const day = (n: number) => new Date(Date.UTC(2026, 8, n));

const demand = (lineNo: number, itemId: bigint, qty: number, uomId = 1n): PickingDemand => ({
  lineNo,
  itemId,
  uomId,
  qty: D(qty),
});

const stock = (over: Partial<StockCandidate> & { warehouseId: bigint; lotId: bigint; qty: number }): StockCandidate => ({
  locationId: over.warehouseId * 10n,
  itemId: 100n,
  uomId: 1n,
  expiryDate: null,
  lotCreatedAt: day(1),
  ...over,
  availableQty: D(over.qty),
});

const shape = (result: ReturnType<typeof allocatePicking>) => ({
  orders: result.orders.map((order) => ({
    warehouseId: order.warehouseId,
    lines: order.lines.map((line) => [line.lineNo, line.itemId, line.lotId, line.plannedQty.toNumber()]),
  })),
  shortages: result.shortages.map((s) => [s.requestLineNo, s.itemId, s.shortQty.toNumber()]),
});

describe('피킹 배정 (P-12 · 문의 045)', () => {
  it('ⓐ 가용 합이 큰 창고 하나에서만 집고 넘쳐 채우지 않는다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 80)],
      [
        stock({ warehouseId: 1n, lotId: 11n, qty: 30 }),
        stock({ warehouseId: 2n, lotId: 21n, qty: 50 }),
      ],
      new Set(),
    );
    expect(shape(result)).toEqual({ orders: [{ warehouseId: 2n, lines: [[1, 100n, 21n, 50]] }], shortages: [[1, 100n, 30]] });
  });

  it('ⓐ 가용 합이 같으면 warehouse_id 가 작은 창고다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 10)],
      [stock({ warehouseId: 9n, lotId: 91n, qty: 40 }), stock({ warehouseId: 3n, lotId: 31n, qty: 40 })],
      new Set(),
    );
    expect(result.orders.map((order) => order.warehouseId)).toEqual([3n]);
  });

  it('ⓒ FIFO — LOT 생성 시각 오름차순으로 나눠 집는다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 70)],
      [
        stock({ warehouseId: 1n, lotId: 12n, qty: 50, lotCreatedAt: day(5) }),
        stock({ warehouseId: 1n, lotId: 13n, qty: 50, lotCreatedAt: day(2), expiryDate: day(30) }),
      ],
      new Set(),
    );
    expect(shape(result).orders[0].lines).toEqual([[1, 100n, 13n, 50], [2, 100n, 12n, 20]]);
  });

  it('ⓒ FEFO — 유효기한 오름차순이고 기한 없는 LOT 은 뒤다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 70)],
      [
        stock({ warehouseId: 1n, lotId: 11n, qty: 50, lotCreatedAt: day(1) }),
        stock({ warehouseId: 1n, lotId: 12n, qty: 50, lotCreatedAt: day(9), expiryDate: day(20) }),
        stock({ warehouseId: 1n, lotId: 13n, qty: 10, lotCreatedAt: day(8), expiryDate: day(15) }),
      ],
      new Set([100n]),
    );
    expect(shape(result).orders[0].lines).toEqual([[1, 100n, 13n, 10], [2, 100n, 12n, 50], [3, 100n, 11n, 10]]);
  });

  it('ⓓ 재고가 없으면 라인·헤더 없이 결품만 남는다', () => {
    const result = allocatePicking([demand(1, 100n, 5), demand(2, 200n, 7)], [], new Set());
    expect(shape(result)).toEqual({ orders: [], shortages: [[1, 100n, 5], [2, 200n, 7]] });
  });

  it('창고가 갈리는 품목은 창고별 헤더로 나뉘고 라인 번호는 헤더마다 1부터다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 10), demand(2, 200n, 10), demand(3, 300n, 10)],
      [
        stock({ warehouseId: 2n, lotId: 21n, qty: 10, itemId: 100n }),
        stock({ warehouseId: 1n, lotId: 11n, qty: 10, itemId: 200n }),
        stock({ warehouseId: 2n, lotId: 22n, qty: 10, itemId: 300n }),
      ],
      new Set(),
    );
    expect(shape(result).orders).toEqual([
      { warehouseId: 1n, lines: [[1, 200n, 11n, 10]] },
      { warehouseId: 2n, lines: [[1, 100n, 21n, 10], [2, 300n, 22n, 10]] },
    ]);
  });

  it('같은 품목의 요청 라인이 둘이면 앞 라인이 쓴 나머지에서 집는다', () => {
    const result = allocatePicking(
      [demand(1, 100n, 30), demand(2, 100n, 30)],
      [stock({ warehouseId: 1n, lotId: 11n, qty: 40 })],
      new Set(),
    );
    expect(shape(result)).toEqual({
      orders: [{ warehouseId: 1n, lines: [[1, 100n, 11n, 30], [2, 100n, 11n, 10]] }],
      shortages: [[2, 100n, 20]],
    });
  });

  it('단위가 다른 재고는 후보가 아니다', () => {
    const result = allocatePicking([demand(1, 100n, 5, 2n)], [stock({ warehouseId: 1n, lotId: 11n, qty: 50 })], new Set());
    expect(shape(result)).toEqual({ orders: [], shortages: [[1, 100n, 5]] });
  });
});
