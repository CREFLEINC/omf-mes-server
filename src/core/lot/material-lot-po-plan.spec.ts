import { Prisma } from '@prisma/client';

import type { StockUomTable } from '../bom/stock-uom';
import { issueMaterialLotBatchWithin } from './lot-registry-batch';
import { ensureMaterialLotsWithin, materialLotDefaultsOf, planMaterialLotShares, type PoPlanLine } from './material-lot-po-plan';

jest.mock('./lot-registry-batch', () => ({ issueMaterialLotBatchWithin: jest.fn() }));

/** 피처 014 — P/O 몫 계산(data-model §4 · R-2·R-3). */
describe('planMaterialLotShares', () => {
  const d = (value: number) => new Prisma.Decimal(value);
  const line = (id: number, remaining: number): PoPlanLine => ({ purchaseOrderLineId: BigInt(id), remainingQty: d(remaining) });
  const shape = (lots: ReturnType<typeof planMaterialLotShares>) =>
    lots.map((lot) => [Number(lot.purchaseOrderLineId), lot.qty.toNumber(), lot.packageCount, lot.qtyPerPackage?.toNumber() ?? null]);
  const packaged = { lotQty: d(100), packageCount: 10 };
  const bare = { lotQty: d(100), packageCount: null };

  it('US1-1 남은 300·크기 100 → 100×3', () => {
    expect(shape(planMaterialLotShares([line(1, 300)], d(0), bare))).toEqual([[1, 100, null, null], [1, 100, null, null], [1, 100, null, null]]);
  });

  it('US1-3·Q1 라인 250(11-01)·100(11-05) → 100·100·50 / 100, 나머지 50 은 패키징 5×10', () => {
    expect(shape(planMaterialLotShares([line(1, 250), line(2, 100)], d(0), packaged))).toEqual([
      [1, 100, 10, 10], [1, 100, 10, 10], [1, 50, 5, 10], [2, 100, 10, 10],
    ]);
  });

  it('US1-6 Q1 나머지 45 는 패키징 크기로 올려 50·5개, 올림 초과 5 는 다음 라인 몫에서 빠진다(100 → 95 → 100·10개)', () => {
    expect(shape(planMaterialLotShares([line(1, 245), line(2, 100)], d(0), packaged))).toEqual([
      [1, 100, 10, 10], [1, 100, 10, 10], [1, 50, 5, 10], [2, 100, 10, 10],
    ]);
    // 다음 라인이 초과분보다 작으면 그 라인은 만들지 않는다.
    expect(shape(planMaterialLotShares([line(1, 245), line(2, 5), line(3, 10)], d(0), packaged))).toEqual([
      [1, 100, 10, 10], [1, 100, 10, 10], [1, 50, 5, 10], [3, 10, 1, 10],
    ]);
  });

  it('US1-6 FR-004 패키징이 없으면 나머지 45 그대로', () => {
    expect(shape(planMaterialLotShares([line(1, 245)], d(0), bare))).toEqual([[1, 100, null, null], [1, 100, null, null], [1, 45, null, null]]);
  });

  it('US1-2 받기 전 자동 LOT 이 이미 몫을 덮으면 0', () => {
    expect(planMaterialLotShares([line(1, 250), line(2, 100)], d(350), packaged)).toEqual([]);
  });

  it('R-2 자동 LOT 합은 라인 차례(발주일 순)로 덮는다 — 앞 라인을 다 덮고 남은 양이 다음 라인을 덮는다', () => {
    expect(shape(planMaterialLotShares([line(1, 250), line(2, 100)], d(270), bare))).toEqual([[2, 80, null, null]]);
    expect(shape(planMaterialLotShares([line(1, 250), line(2, 100)], d(200), bare))).toEqual([[1, 50, null, null], [2, 100, null, null]]);
  });

  it('R-4 앞쪽만 만든 뒤 다시 계산하면 같은 차례의 나머지가 나온다(쪽 나눔에도 몫이 같다)', () => {
    const all = shape(planMaterialLotShares([line(1, 245), line(2, 100)], d(0), packaged));
    for (let made = 0; made <= all.length; made += 1) {
      const covered = all.slice(0, made).reduce((sum, lot) => sum + (lot[1] as number), 0);
      expect(shape(planMaterialLotShares([line(1, 245), line(2, 100)], d(covered), packaged))).toEqual(all.slice(made));
    }
  });

  it('Q10·FR-009 감량으로 자동 LOT 이 몫을 넘으면 만들 양 0 — 음수 없음', () => {
    expect(planMaterialLotShares([line(1, 100)], d(500), packaged)).toEqual([]);
    expect(planMaterialLotShares([line(1, 0)], d(0), packaged)).toEqual([]);
  });

  it('US1-6 패키징 count = LOT 당 패키징 수량, qtyPerPackage = qty ÷ count(소수 기본크기도)', () => {
    expect(shape(planMaterialLotShares([line(1, 5)], d(0), { lotQty: d(2.5), packageCount: 5 }))).toEqual([
      [1, 2.5, 5, 0.5], [1, 2.5, 5, 0.5],
    ]);
  });
});

describe('materialLotDefaultsOf', () => {
  const table = (conversions: StockUomTable['conversions'] = []): StockUomTable => ({
    stockUomOf: new Map([[7n, 1n]]),
    itemCodeOf: new Map([[7n, 'A']]),
    uoms: new Map([[1n, { code: 'EA', scale: 0 }], [2n, { code: 'ROLL', scale: 0 }]]),
    conversions,
  });
  const item = (overrides: Record<string, unknown> = {}) => ({
    item_id: 7n, default_lot_storage_uom_id: 1n as bigint | null,
    default_production_lot_size: new Prisma.Decimal(100) as Prisma.Decimal | null, default_package_count: 10 as number | null,
    ...overrides,
  });

  it('US1-4 기본 단위나 기본 수량이 없으면 NO_DEFAULT', () => {
    expect(materialLotDefaultsOf(item({ default_lot_storage_uom_id: null }), table())).toEqual({ status: 'NO_DEFAULT' });
    expect(materialLotDefaultsOf(item({ default_production_lot_size: null }), table())).toEqual({ status: 'NO_DEFAULT' });
  });

  it('US1-5 보관 단위 → 기본 단위 환산이 없으면 NO_CONVERSION', () => {
    expect(materialLotDefaultsOf(item({ default_lot_storage_uom_id: 2n }), table())).toEqual({ status: 'NO_CONVERSION' });
  });

  it('OK — LOT 크기는 기본 단위로 바꾼 값, 패키징 수는 품목 값', () => {
    const converted = materialLotDefaultsOf(item({ default_lot_storage_uom_id: 2n, default_production_lot_size: new Prisma.Decimal(2) }), table([
      { item_id: 7n, from_uom_id: 1n, to_uom_id: 2n, conversion_rate: new Prisma.Decimal('0.01'), effective_from: new Date('2026-01-01') },
    ]));
    expect(converted).toMatchObject({ status: 'OK', defaults: { packageCount: 10 } });
    expect(converted.status === 'OK' && converted.defaults.lotQty.toNumber()).toBe(200);
    expect(materialLotDefaultsOf(item({ default_package_count: null }), table())).toMatchObject({ status: 'OK', defaults: { packageCount: null } });
  });
});

describe('ensureMaterialLotsWithin', () => {
  const issue = issueMaterialLotBatchWithin as jest.MockedFunction<typeof issueMaterialLotBatchWithin>;
  const tx = (outstanding: number | null) => {
    let next = 500n;
    issue.mockReset().mockImplementation(async (_tx, input) => ({
      batchId: 1n, lotIds: Array.from({ length: input.lotCount }, () => (next += 1n)),
    }));
    const plans: unknown[] = [];
    const queries: string[] = [];
    const client = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return strings.join('').includes('sum(') ? [{ qty: outstanding === null ? null : new Prisma.Decimal(outstanding) }] : [];
      }),
      item: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ item_id: 7n, base_uom_id: 1n, default_lot_storage_uom_id: 1n,
          default_production_lot_size: new Prisma.Decimal(100), default_package_count: 10, default_package_uom_id: 31n }),
        findMany: jest.fn().mockResolvedValue([{ item_id: 7n, item_code: 'A', base_uom_id: 1n }]),
      },
      uom: { findMany: jest.fn().mockResolvedValue([{ uom_id: 1n, uom_code: 'EA', decimal_scale: 0 }]) },
      item_uom_conversion: { findMany: jest.fn().mockResolvedValue([]) },
      purchase_order_line: { findMany: jest.fn().mockResolvedValue([
        { purchase_order_line_id: 11n, ordered_qty: new Prisma.Decimal(250), received_qty: new Prisma.Decimal(0) },
        { purchase_order_line_id: 12n, ordered_qty: new Prisma.Decimal(100), received_qty: new Prisma.Decimal(0) },
      ]) },
      material_lot_po_plan: { createMany: jest.fn(async ({ data }: { data: unknown[] }) => plans.push(...data)) },
    } as unknown as Prisma.TransactionClient;
    return { client, plans, queries };
  };
  const input = { plantId: 3, supplierId: 5, itemId: 7, upTo: 10, businessDate: '2026-11-23' };
  const actor = { channel: 'WEB' as const, appUserId: 9 };

  it('US1-3·Q1 잠근 뒤 라인마다 AUTO 묶음(나머지는 따로), 몫 기록을 라인으로 남긴다', async () => {
    const { client, plans, queries } = tx(null);
    const result = await ensureMaterialLotsWithin(client, input, actor);

    expect(queries[0]).toContain('pg_advisory_xact_lock');
    expect(issue.mock.calls.map(([, batch, , mode]) => [batch.lotQty, batch.lotCount, batch.package, mode])).toEqual([
      [100, 2, { uomId: 31, count: 10, qtyPerPackage: 10 }, 'AUTO'],
      [50, 1, { uomId: 31, count: 5, qtyPerPackage: 10 }, 'AUTO'],
      [100, 1, { uomId: 31, count: 10, qtyPerPackage: 10 }, 'AUTO'],
    ]);
    expect(plans).toEqual([501n, 502n, 503n, 504n].map((lot_id, index) => ({ lot_id, purchase_order_line_id: index < 3 ? 11n : 12n })));
    expect(result).toEqual({ status: 'OK', createdLotIds: [501n, 502n, 503n, 504n], creatableRemaining: 0 });
  });

  it('US2-1 upTo 개까지만 만들고 남은 수를 알린다, US1-2 덮였으면 만들지 않는다', async () => {
    expect(await ensureMaterialLotsWithin(tx(null).client, { ...input, upTo: 1 }, actor)).toMatchObject({ createdLotIds: [501n], creatableRemaining: 3 });
    expect(await ensureMaterialLotsWithin(tx(350).client, input, actor)).toEqual({ status: 'OK', createdLotIds: [], creatableRemaining: 0 });
    expect(issue).not.toHaveBeenCalled();
  });
});
