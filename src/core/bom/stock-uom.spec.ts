import { Prisma } from '@prisma/client';

import { StockUomTable, toStockUom } from './stock-uom';

const KG = 1n;
const GR = 2n;
const EA = 3n;
const PC = 4n;
const BOX = 5n;
const ITEM = 10n;
const d = (value: string | number) => new Prisma.Decimal(value);

function table(stockUomId: bigint, conversions: StockUomTable['conversions'] = []): StockUomTable {
  return {
    stockUomOf: new Map([[ITEM, stockUomId]]),
    itemCodeOf: new Map([[ITEM, 'RESIN']]),
    uoms: new Map([
      [KG, { code: 'KG', scale: 3 }],
      [GR, { code: 'GR', scale: 3 }],
      [EA, { code: 'EA', scale: 0 }],
      [PC, { code: 'PC', scale: 0 }],
      [BOX, { code: 'BOX', scale: 0 }],
    ]),
    conversions,
  };
}

function row(from: bigint, to: bigint, rate: string | number, effectiveFrom = '2026-11-01') {
  return { item_id: ITEM, from_uom_id: from, to_uom_id: to, conversion_rate: d(rate), effective_from: new Date(`${effectiveFrom}T00:00:00Z`) };
}

describe('core/bom — 재고 단위 환산', () => {
  it('품목 환산(재고 → BOM)으로 367 GR 을 0.367 KG 로 바꾼다', () => {
    const result = toStockUom(table(KG, [row(KG, GR, 1000)]), ITEM, GR, d('367'));
    expect(result).toMatchObject({ source: 'ITEM', stockUomId: KG });
    expect([result.rate?.toString(), result.stockQty?.toString()]).toEqual(['1000', '0.367']);
  });

  it('역방향 품목 환산(BOM → 재고)도 쓰고, 나누지 않고 곱해 올림이 튀지 않는다', () => {
    const result = toStockUom(table(KG, [row(BOX, KG, '0.007')]), ITEM, BOX, d(1000));
    expect(result.source).toBe('ITEM');
    // 1 ÷ 0.007 로 한 번 나눈 비율로 다시 나누면 7.000…1 이 되어 7.001 로 올림된다.
    expect(result.stockQty?.toString()).toBe('7');
  });

  it('품목 환산이 공통 환산보다 먼저다', () => {
    const result = toStockUom(table(KG, [row(KG, GR, 900)]), ITEM, GR, d(367));
    expect(result.source).toBe('ITEM');
    expect(result.stockQty?.toString()).toBe('0.408');
  });

  it('같은 방향이 여럿이면 가장 늦게 시작한 것을 쓴다(읽을 때 시작일 내림차순)', () => {
    const result = toStockUom(table(KG, [row(KG, GR, 500, '2026-11-10'), row(KG, GR, 1000, '2026-01-01')]), ITEM, GR, d(1000));
    expect(result.stockQty?.toString()).toBe('2');
  });

  it('품목 환산이 없으면 공통 환산 — 질량 KG·GR, 개수 EA·PC', () => {
    expect(toStockUom(table(KG), ITEM, GR, d(367))).toMatchObject({ source: 'COMMON' });
    expect(toStockUom(table(KG), ITEM, GR, d(367)).stockQty?.toString()).toBe('0.367');
    expect(toStockUom(table(GR), ITEM, KG, d('0.0004')).stockQty?.toString()).toBe('0.4');
    // 개수는 정수 자릿수로 올림한다.
    expect(toStockUom(table(EA), ITEM, PC, d('2.3')).stockQty?.toString()).toBe('3');
  });

  it('재고 단위 자릿수에서 올림한다 — 0.4 GR 은 0.001 KG', () => {
    expect(toStockUom(table(KG), ITEM, GR, d('0.4')).stockQty?.toString()).toBe('0.001');
  });

  it('차원이 다르거나 공통 환산 밖이면 없음(NONE) — 수량을 내지 않는다', () => {
    expect(toStockUom(table(KG), ITEM, EA, d(1))).toMatchObject({ source: 'NONE', rate: null, stockQty: null });
    expect(toStockUom(table(EA), ITEM, BOX, d(1))).toMatchObject({ source: 'NONE' });
  });

  it('단위가 같으면 확인할 것이 없다(출처 null) — 수량 그대로', () => {
    const result = toStockUom(table(KG), ITEM, KG, d('1.23456'));
    expect(result).toMatchObject({ source: null, rate: null });
    expect(result.stockQty?.toString()).toBe('1.23456');
  });
});
