import { ContractException, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryAdjustmentLineCreate,
  LocationOrg,
  assertSinglePlant,
  lineTargetErrors,
  resolveLineDimensions,
} from './inventory-adjustment-rules';

const ITEM = 2001;
const OTHER_ITEM = 2002;
const LOT = 3001;
const UOM = 5;
const LOCATION = 4001;
const OTHER_LOCATION = 4002;
const COUNT_LINE = 6001;
const COUNT = 8001;
const OTHER_COUNT = 8002;
const WAREHOUSE = 1001n;
const PLANT = 7n;
const OTHER_PLANT = 8n;

type Row = Record<string, unknown>;

const line = (over: Partial<InventoryAdjustmentLineCreate> = {}): InventoryAdjustmentLineCreate => ({
  locationId: LOCATION,
  itemId: ITEM,
  lotId: LOT,
  adjustmentQty: -3,
  uomId: UOM,
  ...over,
});

interface Seed {
  items?: number[];
  lots?: { lot_id: number; item_id: number }[];
  uoms?: number[];
  locations?: { location_id: number; warehouse_id: bigint; plant_id: bigint }[];
  countLines?: { inventory_count_line_id: number; inventory_count_id: number }[];
}

/** `lineTargetErrors` 가 부르는 다섯 표에만 답하는 최소 prisma 스텁. */
function stub(seed: Seed = {}) {
  const locations = seed.locations ?? [
    { location_id: LOCATION, warehouse_id: WAREHOUSE, plant_id: PLANT },
  ];
  const models: Row = {
    item: { findMany: async () => (seed.items ?? [ITEM]).map((item_id) => ({ item_id })) },
    lot: { findMany: async () => seed.lots ?? [{ lot_id: LOT, item_id: ITEM }] },
    uom: { findMany: async () => (seed.uoms ?? [UOM]).map((uom_id) => ({ uom_id })) },
    location: {
      findMany: async () =>
        locations.map((row) => ({
          location_id: row.location_id,
          warehouse_id: row.warehouse_id,
          warehouse: {
            business_unit_id: 2n,
            plant_id: row.plant_id,
            plant: { legal_entity_id: 1n },
          },
        })),
    },
    inventory_count_line: {
      findMany: async () =>
        seed.countLines ?? [{ inventory_count_line_id: COUNT_LINE, inventory_count_id: COUNT }],
    },
  };
  return models as unknown as PrismaService;
}

const run = async (
  lines: InventoryAdjustmentLineCreate[],
  seed: Seed = {},
  array: 'lines' | 'items' = 'lines',
  inventoryCountId: number | null = COUNT,
): Promise<{ errors: ErrorItem[]; orgs: Map<number, LocationOrg> }> => {
  const errors: ErrorItem[] = [];
  const orgs = await lineTargetErrors(stub(seed), lines, array, inventoryCountId, errors);
  return { errors, orgs };
};

const fields = (errors: ErrorItem[]): (string | undefined)[] => errors.map((item) => item.field);

describe('lineTargetErrors — 라인 축 FK 그물', () => {
  it('전건이 실재하면 오류 0 이고 위치 → 조직 축 대응표를 낸다', async () => {
    const { errors, orgs } = await run([line({ inventoryCountLineId: COUNT_LINE })]);

    expect(errors).toHaveLength(0);
    expect(orgs.get(LOCATION)).toEqual({
      legal_entity_id: 1n,
      business_unit_id: 2n,
      plant_id: PLANT,
      warehouse_id: WAREHOUSE,
    });
  });

  it('없는 품목·단위·위치를 각각 짚는다', async () => {
    const { errors } = await run([line({ lotId: null })], { items: [], uoms: [], locations: [] });

    expect(fields(errors)).toEqual(['lines[0].itemId', 'lines[0].uomId', 'lines[0].locationId']);
  });

  it('없는 LOT 을 짚는다', async () => {
    const { errors } = await run([line()], { lots: [] });

    expect(fields(errors)).toEqual(['lines[0].lotId']);
  });

  it('LOT 의 품목이 라인 품목과 다르면 `itemId` 를 짚는다 — 원장 계보가 그 두 축으로 이어진다', async () => {
    const { errors } = await run([line()], { lots: [{ lot_id: LOT, item_id: OTHER_ITEM }] });

    expect(fields(errors)).toEqual(['lines[0].itemId']);
  });

  it('없는 실사 라인을 짚는다', async () => {
    const { errors } = await run([line({ inventoryCountLineId: COUNT_LINE })], { countLines: [] });

    expect(fields(errors)).toEqual(['lines[0].inventoryCountLineId']);
  });

  it('⭐ 실재해도 «남의 실사» 라인이면 짚는다 — I-15 `:close` 의 라인 축 판정이 무너진다', async () => {
    const { errors } = await run([line({ inventoryCountLineId: COUNT_LINE })], {
      countLines: [{ inventory_count_line_id: COUNT_LINE, inventory_count_id: OTHER_COUNT }],
    });

    expect(fields(errors)).toEqual(['lines[0].inventoryCountLineId']);
  });

  it('헤더가 실사를 안 가리키는데 라인이 실사 라인을 짚으면 오류다', async () => {
    const { errors } = await run([line({ inventoryCountLineId: COUNT_LINE })], {}, 'lines', null);

    expect(fields(errors)).toEqual(['lines[0].inventoryCountLineId']);
  });

  it('오류가 짚는 배열 이름이 오퍼레이션마다 다르다 — 치환은 `items` 다', async () => {
    const { errors } = await run([line()], { items: [] }, 'items');

    expect(fields(errors)).toEqual(['items[0].itemId']);
  });

  it('라인이 여럿이면 제 첨자를 짚는다', async () => {
    const { errors } = await run([line(), line({ uomId: 9 })]);

    expect(fields(errors)).toEqual(['lines[1].uomId']);
  });
});

describe('assertSinglePlant — 한 전표는 한 공장이다', () => {
  const orgs = (rows: [number, bigint][]): Map<number, LocationOrg> =>
    new Map(
      rows.map(([locationId, plant_id]) => [
        locationId,
        { legal_entity_id: 1n, business_unit_id: 2n, plant_id, warehouse_id: WAREHOUSE },
      ]),
    );

  it('같은 공장이면 통과한다', () => {
    const errors: ErrorItem[] = [];
    assertSinglePlant(
      [line(), line({ locationId: OTHER_LOCATION })],
      orgs([
        [LOCATION, PLANT],
        [OTHER_LOCATION, PLANT],
      ]),
      'lines',
      errors,
    );

    expect(errors).toHaveLength(0);
  });

  it('두 공장에 걸치면 어긋난 라인을 짚는다', () => {
    const errors: ErrorItem[] = [];
    assertSinglePlant(
      [line(), line({ locationId: OTHER_LOCATION })],
      orgs([
        [LOCATION, PLANT],
        [OTHER_LOCATION, OTHER_PLANT],
      ]),
      'items',
      errors,
    );

    expect(fields(errors)).toEqual(['items[1].locationId']);
  });

  it('위치를 못 찾은 라인이 있으면 판정하지 않는다 — 그 라인의 오류가 이미 서 있다', () => {
    const errors: ErrorItem[] = [];
    assertSinglePlant(
      [line(), line({ locationId: OTHER_LOCATION })],
      orgs([[LOCATION, PLANT]]),
      'lines',
      errors,
    );

    expect(errors).toHaveLength(0);
  });
});

describe('resolveLineDimensions — 잔액 행이 라인의 두 상태 칸을 준다', () => {
  const ORG: LocationOrg = {
    legal_entity_id: 1n,
    business_unit_id: 2n,
    plant_id: PLANT,
    warehouse_id: WAREHOUSE,
  };
  const orgs = new Map<number, LocationOrg>([
    [LOCATION, ORG],
    [OTHER_LOCATION, ORG],
  ]);

  const balance = (over: Row = {}): Row => ({
    ...ORG,
    location_id: BigInt(LOCATION),
    item_id: BigInt(ITEM),
    lot_id: BigInt(LOT),
    quality_status_code: 'NORMAL',
    inventory_status_code: 'AVAILABLE',
    ...over,
  });

  /** ⭐ 한 문장으로만 읽는다 — 호출 수를 세어 N+1 로 되돌아가는 것을 막는다. */
  const balances = (rows: Row[]): { prisma: PrismaService; calls: () => number } => {
    let calls = 0;
    const models: Row = {
      inventory_balance: {
        findMany: async () => {
          calls += 1;
          return rows;
        },
      },
    };
    return { prisma: models as unknown as PrismaService, calls: () => calls };
  };

  const reject = async (
    lines: InventoryAdjustmentLineCreate[],
    rows: Row[],
    array: 'lines' | 'items' = 'lines',
  ): Promise<ErrorItem[]> => {
    const { prisma } = balances(rows);
    try {
      await resolveLineDimensions(prisma, lines, orgs, array);
    } catch (error) {
      return (error as ContractException).errors;
    }
    throw new Error('400 이 나야 한다');
  };

  it('1행이면 그 행의 두 코드를 낸다', async () => {
    const { prisma } = balances([balance()]);

    await expect(resolveLineDimensions(prisma, [line()], orgs, 'lines')).resolves.toEqual([
      { qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE' },
    ]);
  });

  it('⭐ 라인이 여럿이어도 잔액을 «한 번만» 읽고 키로 갈라 준다', async () => {
    const { prisma, calls } = balances([
      balance(),
      balance({ location_id: BigInt(OTHER_LOCATION), quality_status_code: 'HOLD' }),
    ]);

    const dimensions = await resolveLineDimensions(
      prisma,
      [line(), line({ locationId: OTHER_LOCATION }), line()],
      orgs,
      'lines',
    );

    expect(calls()).toBe(1);
    expect(dimensions.map((d) => d.qualityStatusCode)).toEqual(['NORMAL', 'HOLD', 'NORMAL']);
  });

  it('LOT 이 널인 라인은 널인 잔액 행에만 붙는다', async () => {
    const { prisma } = balances([balance({ lot_id: null, inventory_status_code: 'BLOCKED' })]);

    const dimensions = await resolveLineDimensions(prisma, [line({ lotId: null })], orgs, 'lines');

    expect(dimensions[0].inventoryStatusCode).toBe('BLOCKED');
  });

  it('0행 · 감(−)은 NEGATIVE_BALANCE 다', async () => {
    const errors = await reject([line({ adjustmentQty: -1 })], []);

    expect(errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'NEGATIVE_BALANCE' });
  });

  it('0행 · 증(+)은 INVALID 다 — 어느 상태로 넣을지 정할 수 없다', async () => {
    const errors = await reject([line({ adjustmentQty: 5 })], []);

    expect(errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'INVALID' });
  });

  it('2행 이상이면 INVALID 이고 치환은 `items` 를 짚는다', async () => {
    const errors = await reject(
      [line()],
      [balance(), balance({ inventory_status_code: 'BLOCKED' })],
      'items',
    );

    expect(errors[0]).toMatchObject({ field: 'items[0].locationId', code: 'INVALID' });
  });
});
