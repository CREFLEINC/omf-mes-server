import { Prisma } from '@prisma/client';

import { MaterialIssueLine } from './requirement';

/**
 * BOM 단위 소요 → 재고 단위(품목 `base_uom_id`). 배포·배포 전 조회·출고요청 부족 조회·추가 출고 요청이 «이 한 함수»로 바꾼다 —
 * 갈리면 배포 확인 화면이 본 수량과 출고요청 수량이 어긋난다.
 * 출처 우선순위: 품목 환산(`mdm.item_uom_conversion`, 유효일 기준 · 역방향 포함) → 공통 환산 상수 → 없음.
 * 변환 뒤 수량은 재고 단위 `decimal_scale` 로 올림한다 — 내림하면 출고가 소요보다 모자란다.
 */

export type UomConversionSource = 'ITEM' | 'COMMON' | 'NONE';

/**
 * 같은 차원 공통 환산 — 그 차원 기준 단위 몇 개인가. ⛔ 지금 `mdm.uom` 에 있는 코드만 둔다(단위가 늘면 그때 더한다).
 * M·M2·SH·PLT·BOX 는 품목마다 달라 넣지 않는다. EA·PC 는 같은 뜻의 코드 혼용(PC = 「개(ERP)」)이다.
 */
const COMMON_UNITS: Readonly<Record<string, { dimension: string; size: number }>> = {
  KG: { dimension: 'MASS', size: 1000 },
  GR: { dimension: 'MASS', size: 1 },
  G: { dimension: 'MASS', size: 1 },
  EA: { dimension: 'COUNT', size: 1 },
  PC: { dimension: 'COUNT', size: 1 },
};

interface ConversionRow {
  item_id: bigint;
  from_uom_id: bigint;
  to_uom_id: bigint;
  conversion_rate: Prisma.Decimal;
  effective_from: Date;
}

/** 환산에 필요한 기준정보 — 트랜잭션 안팎 어디서든 한 번 읽어 여러 줄에 쓴다. */
export interface StockUomTable {
  stockUomOf: Map<bigint, bigint>;
  itemCodeOf: Map<bigint, string>;
  uoms: Map<bigint, { code: string; scale: number }>;
  conversions: ConversionRow[];
}

export interface StockUomConversion {
  bomUomId: bigint;
  stockUomId: bigint;
  /** 단위가 같으면 `null` — 확인할 것이 없다. */
  source: UomConversionSource | null;
  /** 「1 재고 단위 = N BOM 단위」의 N. 단위가 같거나 환산이 없으면 `null`. */
  rate: Prisma.Decimal | null;
  /** 재고 단위 수량(올림 뒤). 환산이 없으면 `null`. */
  stockQty: Prisma.Decimal | null;
}

type Reader = Pick<Prisma.TransactionClient, 'item' | 'uom' | 'item_uom_conversion'>;

/** `onDate` 는 공장 현지 오늘(`YYYY-MM-DD`) — 품목 환산의 유효일 판정 기준이다. */
export async function loadStockUomTable(db: Reader, itemIds: bigint[], onDate: string): Promise<StockUomTable> {
  const ids = [...new Set(itemIds)];
  const day = new Date(`${onDate}T00:00:00.000Z`);
  const [items, uoms, conversions] = await Promise.all([
    db.item.findMany({ where: { item_id: { in: ids } }, select: { item_id: true, item_code: true, base_uom_id: true } }),
    db.uom.findMany({ select: { uom_id: true, uom_code: true, decimal_scale: true } }),
    db.item_uom_conversion.findMany({
      where: { item_id: { in: ids }, effective_from: { lte: day }, OR: [{ effective_to: null }, { effective_to: { gte: day } }] },
      select: { item_id: true, from_uom_id: true, to_uom_id: true, conversion_rate: true, effective_from: true },
      orderBy: [{ effective_from: 'desc' }, { item_uom_conversion_id: 'desc' }],
    }),
  ]);
  return {
    stockUomOf: new Map(items.map((item) => [item.item_id, item.base_uom_id])),
    itemCodeOf: new Map(items.map((item) => [item.item_id, item.item_code])),
    uoms: new Map(uoms.map((uom) => [uom.uom_id, { code: uom.uom_code, scale: uom.decimal_scale }])),
    conversions,
  };
}

/** 「1 재고 단위 = N BOM 단위」 — 역방향 품목 환산이면 나누지 않고 곱하도록 그 원래 비율도 든다(1/r 을 나누면 올림이 한 칸 튄다). */
export interface Ratio {
  rate: Prisma.Decimal;
  stockPerBom?: Prisma.Decimal;
}

/** 품목 환산 — 유효한 것 중 가장 늦게 시작한 것, 같은 날이면 정방향(재고 → BOM)을 먼저 본다. */
export function itemRatio(table: StockUomTable, itemId: bigint, stockUomId: bigint, bomUomId: bigint): Ratio | null {
  const rows = table.conversions.filter((row) => row.item_id === itemId);
  const forward = rows.find((row) => row.from_uom_id === stockUomId && row.to_uom_id === bomUomId);
  const reverse = rows.find((row) => row.from_uom_id === bomUomId && row.to_uom_id === stockUomId);
  if (forward !== undefined && (reverse === undefined || forward.effective_from >= reverse.effective_from)) {
    return { rate: forward.conversion_rate };
  }
  if (reverse === undefined) return null;
  return { rate: new Prisma.Decimal(1).dividedBy(reverse.conversion_rate), stockPerBom: reverse.conversion_rate };
}

function commonRatio(table: StockUomTable, stockUomId: bigint, bomUomId: bigint): Ratio | null {
  const stock = COMMON_UNITS[table.uoms.get(stockUomId)?.code ?? ''];
  const bom = COMMON_UNITS[table.uoms.get(bomUomId)?.code ?? ''];
  if (stock === undefined || bom === undefined || stock.dimension !== bom.dimension) return null;
  return { rate: new Prisma.Decimal(stock.size).dividedBy(bom.size) };
}

/** BOM 수량을 재고 단위로 바꿔 재고 단위 자릿수로 올림한다. */
export function stockQtyOf(table: StockUomTable, stockUomId: bigint, bomQty: Prisma.Decimal, ratio: Ratio): Prisma.Decimal {
  const scale = table.uoms.get(stockUomId)?.scale ?? 0;
  const exact = ratio.stockPerBom === undefined ? bomQty.dividedBy(ratio.rate) : bomQty.times(ratio.stockPerBom);
  return exact.toDecimalPlaces(scale, Prisma.Decimal.ROUND_UP);
}

export function toStockUom(table: StockUomTable, itemId: bigint, bomUomId: bigint, bomQty: Prisma.Decimal): StockUomConversion {
  const stockUomId = table.stockUomOf.get(itemId) ?? bomUomId;
  if (stockUomId === bomUomId) return { bomUomId, stockUomId, source: null, rate: null, stockQty: bomQty };
  const fromItem = itemRatio(table, itemId, stockUomId, bomUomId);
  const ratio = fromItem ?? commonRatio(table, stockUomId, bomUomId);
  if (ratio === null) return { bomUomId, stockUomId, source: 'NONE', rate: null, stockQty: null };
  const source = fromItem === null ? 'COMMON' : 'ITEM';
  return { bomUomId, stockUomId, source, rate: ratio.rate, stockQty: stockQtyOf(table, stockUomId, bomQty, ratio) };
}

/**
 * 소요 줄을 재고 단위 줄로 바꾼다. 환산이 없는 줄은 BOM 단위 그대로 두고 `conversion.source = 'NONE'` 으로 알린다 —
 * 막을지(배포)·그대로 보일지(부족 조회)는 호출자가 정한다.
 */
export function stockUomLines(
  table: StockUomTable,
  lines: MaterialIssueLine[],
): { line: MaterialIssueLine; bomQty: Prisma.Decimal; conversion: StockUomConversion }[] {
  return lines.map((line) => {
    const conversion = toStockUom(table, line.item_id, line.uom_id, line.requested_qty);
    const converted =
      conversion.stockQty === null ? line : { ...line, requested_qty: conversion.stockQty, uom_id: conversion.stockUomId };
    return { line: converted, bomQty: line.requested_qty, conversion };
  });
}
