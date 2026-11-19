import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { BomComponentRow, materialRequirements } from '../../core/bom';
import { EnteredConversion, MaterialUomConfirmation, releaseMaterials, saveEnteredConversions } from './release-materials';

const KG = 1n;
const GR = 2n;
const EA = 3n;
const PC = 4n;
const RESIN = 10n;
const BOLT = 11n;
const d = (value: string | number) => new Prisma.Decimal(value);

function component(id: bigint, itemId: bigint, uomId: bigint, qty: string): BomComponentRow {
  return { bom_component_id: id, component_item_id: itemId, uom_id: uomId, required_qty: d(qty) };
}

/** 수지는 재고 KG(BOM GR), 볼트는 재고·BOM 모두 EA. */
function db(conversions: { from: bigint; to: bigint; rate: string }[] = []) {
  return {
    item: {
      findMany: async () => [
        { item_id: RESIN, item_code: 'RESIN', base_uom_id: KG },
        { item_id: BOLT, item_code: 'BOLT', base_uom_id: EA },
      ],
    },
    uom: {
      findMany: async () => [
        { uom_id: KG, uom_code: 'KG', decimal_scale: 3 },
        { uom_id: GR, uom_code: 'GR', decimal_scale: 3 },
        { uom_id: EA, uom_code: 'EA', decimal_scale: 0 },
        { uom_id: PC, uom_code: 'PC', decimal_scale: 0 },
      ],
    },
    item_uom_conversion: {
      findMany: async () =>
        conversions.map((row) => ({
          item_id: RESIN,
          from_uom_id: row.from,
          to_uom_id: row.to,
          conversion_rate: d(row.rate),
          effective_from: new Date('2026-11-01T00:00:00Z'),
        })),
    },
  } as never;
}

function run(
  components: BomComponentRow[],
  options: { confirmations?: MaterialUomConfirmation[]; automatic?: boolean; conversions?: { from: bigint; to: bigint; rate: string }[] } = {},
) {
  return releaseMaterials(db(options.conversions), {
    required: materialRequirements(components, d(10), d(1)),
    plantToday: '2026-11-18',
    confirmations: options.confirmations,
    automatic: options.automatic ?? false,
  });
}

async function errorsOf(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ContractException);
  return (error as ContractException).errors.map((item) => [item.field, item.code]);
}

const resin = component(1n, RESIN, GR, '36.7');
const bolt = component(2n, BOLT, EA, '2');
const kgToGr = { from: KG, to: GR, rate: '1000' };

describe('W/O 배포 — 자재 재고 단위 환산·확인', () => {
  it('단위가 같은 자재뿐이면 확인 없이 지금처럼 담는다', async () => {
    const { lines, entered } = await run([bolt]);
    expect(lines.map((line) => [line.uom_id, line.requested_qty.toString()])).toEqual([[EA, '20']]);
    expect(entered).toEqual([]);
  });

  it('단위가 다른 자재를 확인하지 않으면 400 — field 가 그 BOM 구성 행을 가리킨다', async () => {
    expect(await errorsOf(run([resin, bolt], { conversions: [kgToGr] }))).toEqual([
      ['materialUomConfirmations[bomComponentId=1].confirmed', 'MATERIAL_UOM_CONFIRMATION_REQUIRED'],
    ]);
  });

  it('확인하면 품목 환산으로 재고 단위 줄을 만든다 — 367 GR → 0.367 KG', async () => {
    const { lines, entered } = await run([resin, bolt], { conversions: [kgToGr], confirmations: [{ bomComponentId: 1, confirmed: true }] });
    expect(lines.map((line) => [line.item_id, line.uom_id, line.requested_qty.toString()])).toEqual([
      [RESIN, KG, '0.367'],
      [BOLT, EA, '20'],
    ]);
    expect(entered).toEqual([]);
  });

  it('환산이 없으면 비율을 받아야 한다 — 없으면 400, 있으면 그 비율로 바꾸고 저장할 환산으로 넘긴다', async () => {
    const noRate = { bomComponentId: 1, confirmed: true };
    const resinEa = component(1n, RESIN, EA, '1.5');
    expect(await errorsOf(run([resinEa], { confirmations: [noRate] }))).toEqual([
      ['materialUomConfirmations[bomComponentId=1].conversionRate', 'MATERIAL_UOM_CONFIRMATION_REQUIRED'],
    ]);

    const { lines, entered } = await run([resinEa], { confirmations: [{ ...noRate, conversionRate: 40 }] });
    // 1 KG = 40 EA — 15 EA 는 0.375 KG.
    expect(lines[0].requested_qty.toString()).toBe('0.375');
    expect(entered).toEqual([
      expect.objectContaining({ itemId: RESIN, stockUomId: KG, bomUomId: EA, replacedSource: 'NONE', bomComponentIds: [1] }),
    ]);
    expect(entered[0].rate.toString()).toBe('40');
  });

  it('품목 환산이 있으면 다른 비율은 400(덮어쓰지 않는다), 같은 비율은 통과하고 저장하지 않는다', async () => {
    const confirm = (conversionRate: number) => ({ conversions: [kgToGr], confirmations: [{ bomComponentId: 1, confirmed: true, conversionRate }] });
    expect(await errorsOf(run([resin], confirm(900)))).toEqual([
      ['materialUomConfirmations[bomComponentId=1].conversionRate', 'INVALID'],
    ]);
    const same = await run([resin], confirm(1000));
    expect([same.lines[0].requested_qty.toString(), same.entered]).toEqual(['0.367', []]);
  });

  it('개수 공통 환산(EA·PC)은 비율을 넣으면 그 비율을 쓰고 품목 환산으로 저장한다', async () => {
    const boltPc = component(2n, BOLT, PC, '2');
    const { lines, entered } = await run([boltPc], { confirmations: [{ bomComponentId: 2, confirmed: true, conversionRate: 10 }] });
    // 1 EA = 10 PC — 20 PC 는 2 EA.
    expect(lines[0].requested_qty.toString()).toBe('2');
    expect(entered.map((row) => [row.itemId, row.replacedSource])).toEqual([[BOLT, 'COMMON']]);
  });

  it('질량 공통 환산(KG·GR)은 다른 비율을 받지 않는다 — 같은 비율은 통과하고 저장하지 않는다', async () => {
    const confirm = (conversionRate: number) => ({ confirmations: [{ bomComponentId: 1, confirmed: true, conversionRate }] });
    expect(await errorsOf(run([resin], confirm(500)))).toEqual([
      ['materialUomConfirmations[bomComponentId=1].conversionRate', 'INVALID'],
    ]);
    const same = await run([resin], confirm(1000));
    expect([same.lines[0].requested_qty.toString(), same.entered]).toEqual(['0.367', []]);
  });

  it('자동 배포는 확인 없이 품목·공통 환산을 쓰고, 환산이 없으면 막는다', async () => {
    const { lines } = await run([resin, bolt], { automatic: true });
    expect(lines[0].requested_qty.toString()).toBe('0.367');
    expect(await errorsOf(run([component(1n, RESIN, EA, '1')], { automatic: true }))).toEqual([
      ['materialUomConfirmations[bomComponentId=1]', 'MATERIAL_UOM_CONFIRMATION_REQUIRED'],
    ]);
  });
});

describe('W/O 배포 — 넣은 환산 저장', () => {
  const entered: EnteredConversion = { itemId: RESIN, stockUomId: KG, bomUomId: EA, rate: d(40), replacedSource: 'NONE', bomComponentIds: [1] };
  const context = { workOrderId: 9, plantToday: '2026-11-18', actorId: 7, correlationId: 'key-1' };

  /** 품목 행을 잠근(버전 올림) «뒤에» 읽는 환산 — 먼저 끝난 배포가 넣은 행을 흉내 낸다. */
  function tx(afterLock: { from: bigint; to: bigint; rate: string }[]) {
    const calls: string[] = [];
    const base = db(afterLock) as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    return {
      calls,
      tx: {
        ...base,
        item: {
          ...base.item,
          update: async (args: unknown) => { calls.push(`lock ${JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`); return {}; },
        },
        item_uom_conversion: {
          findMany: async (...args: unknown[]) => { calls.push('read'); return base.item_uom_conversion.findMany(...args); },
          create: async () => { calls.push('create'); return { item_uom_conversion_id: 1n }; },
        },
        audit_event: { create: async () => { calls.push('audit'); return {}; } },
      } as never,
    };
  }

  it('품목 버전을 올려 행을 잠근 뒤 다시 읽고, 없으면 저장하고 감사 기록을 남긴다', async () => {
    const { tx: client, calls } = tx([]);
    await saveEnteredConversions(client, [entered], context);
    expect(calls).toEqual([`lock {"where":{"item_id":${Number(RESIN)}},"data":{"version_no":{"increment":1}},"select":{"item_id":true}}`, 'read', 'create', 'audit']);
  });

  it('잠근 뒤 같은 비율이 이미 있으면 저장을 건너뛰고, 다른 비율이면 400 INVALID', async () => {
    const same = tx([{ from: KG, to: EA, rate: '40' }]);
    await saveEnteredConversions(same.tx, [entered], context);
    expect(same.calls.filter((call) => call === 'create' || call === 'audit')).toEqual([]);

    const other = tx([{ from: KG, to: EA, rate: '50' }]);
    expect(await errorsOf(saveEnteredConversions(other.tx, [entered], context))).toEqual([
      ['materialUomConfirmations[bomComponentId=1].conversionRate', 'INVALID'],
    ]);
  });
});
