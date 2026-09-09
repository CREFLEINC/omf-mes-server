import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { AdjustmentLineWriteInput, PostAdjustmentInput, postAdjustment } from './adjustment-posting';

const LE = 1n;
const BU = 2n;
const PLANT = 3n;
const OTHER_PLANT = 4n;
const WH = 10n;
const LOC = 20n;
const OTHER_LOC = 21n;
/** 같은 공장의 둘째 위치 — 증·감이 섞인 전표를 세우는 자리다. */
const SECOND_LOC = 22n;
const ITEM = 30n;
const LOT = 40n;
const UOM = 5n;
const ADJUSTMENT_ID = 700n;
const NO = 'IA-20260601-0001';
const DAY = '2026-06-01';
const AT = new Date('2026-06-01T01:00:00.000Z');

type Row = Record<string, unknown>;

interface BalanceSeed extends Row {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  lotKey: bigint;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  on_hand_qty: Prisma.Decimal;
  reserved_qty: Prisma.Decimal;
  picked_qty: Prisma.Decimal;
  blocked_qty: Prisma.Decimal;
}

const balance = (over: Partial<BalanceSeed> = {}): BalanceSeed => ({
  legalEntityId: LE,
  businessUnitId: BU,
  plantId: PLANT,
  warehouseId: WH,
  locationId: LOC,
  itemId: ITEM,
  lotKey: LOT,
  ownership_type_code: 'CONSIGNMENT',
  owner_partner_id: 9n,
  on_hand_qty: new Prisma.Decimal(100),
  reserved_qty: new Prisma.Decimal(0),
  picked_qty: new Prisma.Decimal(0),
  blocked_qty: new Prisma.Decimal(0),
  ...over,
});

const line = (over: Partial<AdjustmentLineWriteInput> = {}): AdjustmentLineWriteInput => ({
  inventoryAdjustmentLineId: 900n,
  locationId: LOC,
  itemId: ITEM,
  lotId: LOT,
  adjustmentQty: new Prisma.Decimal(-20),
  uomId: UOM,
  qualityStatusCode: 'NORMAL',
  inventoryStatusCode: 'AVAILABLE',
  ...over,
});

interface Recorded {
  lockSql: string;
  ledgerArgs: Row | undefined;
  backfilled: { id: bigint; ledgerId: bigint }[];
  posted: PostingInput[];
}

function fake(
  seed: { balances?: BalanceSeed[]; allowsNegative?: boolean; ledgerRows?: number } = {},
): { tx: Prisma.TransactionClient; posting: InventoryPostingService; recorded: Recorded } {
  const recorded: Recorded = { lockSql: '', ledgerArgs: undefined, backfilled: [], posted: [] };
  let requested = 0;

  const models: Row = {
    location: {
      findMany: async () =>
        [
          { location_id: LOC, plant_id: PLANT },
          { location_id: SECOND_LOC, plant_id: PLANT },
          { location_id: OTHER_LOC, plant_id: OTHER_PLANT },
        ].map((row) => ({
          location_id: row.location_id,
          warehouse_id: WH,
          warehouse: { business_unit_id: BU, plant_id: row.plant_id, plant: { legal_entity_id: LE } },
        })),
    },
    item: {
      findMany: async () => [{ item_id: ITEM, negative_stock_allowed: seed.allowsNegative ?? false }],
    },
    inventory_transaction_line: {
      findMany: async (args: Row) => {
        recorded.ledgerArgs = args;
        // `ledgerRows` 는 「원장이 조정 라인과 어긋난 상태」를 만드는 자리다(기본은 일치).
        return Array.from({ length: seed.ledgerRows ?? requested }, (_, index) => ({
          inventory_transaction_line_id: BigInt(5000 + index),
        }));
      },
    },
    inventory_adjustment_line: {
      update: async (args: { where: Row; data: Row }) => {
        recorded.backfilled.push({
          id: args.where.inventory_adjustment_line_id as bigint,
          ledgerId: args.data.inventory_transaction_line_id as bigint,
        });
        return {};
      },
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      recorded.lockSql = strings.join('?');
      return seed.balances ?? [balance()];
    },
  };

  const posting = {
    post: async (_tx: Prisma.TransactionClient, input: PostingInput) => {
      recorded.posted.push(input);
      requested = input.lines.length;
      return { inventoryTransactionId: 77n, businessDate: input.businessDate, alreadyPosted: false };
    },
  } as unknown as InventoryPostingService;

  return { tx: models as unknown as Prisma.TransactionClient, posting, recorded };
}

const input = (lines: AdjustmentLineWriteInput[]): PostAdjustmentInput => ({
  inventoryAdjustmentId: ADJUSTMENT_ID,
  inventoryAdjustmentNo: NO,
  lines,
  businessDate: DAY,
  occurredAt: AT,
});

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
};

describe('postAdjustment — 부호가 방향을 정한다', () => {
  it('감(−)은 `from` 만 싣고 `qty` 는 절댓값이다 — 잔액 행의 소유 축을 되읽는다', async () => {
    const { tx, posting, recorded } = fake();

    await postAdjustment(tx, posting, input([line()]), 1);

    const written = recorded.posted[0].lines[0];
    expect(written.qty).toBe(20);
    expect(written.from).toEqual({
      warehouseId: 10,
      locationId: 20,
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    });
    expect(written.to).toBeUndefined();
    expect(written.ownershipTypeCode).toBe('CONSIGNMENT');
    expect(written.ownerPartnerId).toBe(9);
  });

  it('증(+)은 `to` 만 싣는다 — 같은 라인 모양에서 부호 하나로 갈린다', async () => {
    const { tx, posting, recorded } = fake();

    await postAdjustment(tx, posting, input([line({ adjustmentQty: new Prisma.Decimal(5) })]), 1);

    const written = recorded.posted[0].lines[0];
    expect(written.qty).toBe(5);
    expect(written.from).toBeUndefined();
    expect(written.to).toMatchObject({ locationId: 20 });
  });

  it('⭐ 증·감이 섞여도 라인 «순서»가 보존된다 — 되짚기가 자리로 짝짓는다', async () => {
    const { tx, posting, recorded } = fake({
      balances: [balance(), balance({ locationId: SECOND_LOC })],
    });

    await postAdjustment(
      tx,
      posting,
      input([
        line(),
        line({ inventoryAdjustmentLineId: 901n, locationId: SECOND_LOC, adjustmentQty: new Prisma.Decimal(5) }),
      ]),
      1,
    );

    const written = recorded.posted[0].lines;
    expect(written.map((row) => [row.from === undefined, row.to === undefined])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(recorded.backfilled).toEqual([
      { id: 900n, ledgerId: 5000n },
      { id: 901n, ledgerId: 5001n },
    ]);
  });

  it('⭐ `lotId` 가 널이면 `PostingLine.lotId` 를 키에서 «생략»한다 — 0 은 다른 LOT 이다', async () => {
    const { tx, posting, recorded } = fake({ balances: [balance({ lotKey: 0n })] });

    await postAdjustment(tx, posting, input([line({ lotId: null })]), 1);

    expect(Object.keys(recorded.posted[0].lines[0])).not.toContain('lotId');
  });

  it('원장 헤더 — 멱등키·번호·판별자·원천 id, 공장은 라인 위치에서 역산한다', async () => {
    const { tx, posting, recorded } = fake();

    await postAdjustment(tx, posting, input([line()]), 7);

    expect(recorded.posted[0]).toMatchObject({
      transactionTypeCode: 'INVENTORY_ADJUSTMENT',
      transactionNo: NO,
      statusCode: 'POSTED',
      plantId: 3,
      sourceDocumentTypeCode: 'INVENTORY_ADJUSTMENT',
      sourceDocumentId: 700,
      idempotencyKey: `INVENTORY_ADJUSTMENT:${NO}`,
      businessDate: DAY,
      occurredAt: AT,
      createdBy: 7,
    });
  });

  it('한 전표가 두 공장에 걸치면 400 INVALID — 원장 헤더가 거짓을 적게 된다', async () => {
    const { tx, posting } = fake();

    const error = await thrown(() =>
      postAdjustment(tx, posting, input([line(), line({ locationId: OTHER_LOC })]), 1),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines[1].locationId',
      code: 'INVALID',
    });
  });
});

describe('postAdjustment — 음수재고 손검사 세 갈래', () => {
  const errorOf = async (seed: Parameters<typeof fake>[0], qty: number): Promise<Row> => {
    const { tx, posting } = fake(seed);
    const error = await thrown(() =>
      postAdjustment(tx, posting, input([line({ adjustmentQty: new Prisma.Decimal(qty) })]), 1),
    );
    return (error as ContractException).errors[0] as unknown as Row;
  };

  it('갈래① `after >= 0` 인데 예약·피킹·보류 합보다 적으면 400 — 트리거 첫 문장이다', async () => {
    expect(
      await errorOf({ balances: [balance({ reserved_qty: new Prisma.Decimal(90) })] }, -20),
    ).toMatchObject({ field: 'lines[0].adjustmentQty', code: 'NEGATIVE_BALANCE' });
  });

  it('갈래② `after < 0` 이고 음수재고 미허용이면 400', async () => {
    expect(await errorOf({ allowsNegative: false }, -120)).toMatchObject({
      field: 'lines[0].adjustmentQty',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('갈래③ `after < 0` 인데 예약·피킹·보류가 남아 있으면 허용 품목도 400', async () => {
    expect(
      await errorOf(
        { allowsNegative: true, balances: [balance({ blocked_qty: new Prisma.Decimal(1) })] },
        -120,
      ),
    ).toMatchObject({ field: 'lines[0].adjustmentQty', code: 'NEGATIVE_BALANCE' });
  });

  it('⭐ 허용 품목이고 예약이 0 이면 «전기된다» — 잔액이 음수가 되는 조정이 본길이다', async () => {
    const { tx, posting, recorded } = fake({ allowsNegative: true });

    await postAdjustment(tx, posting, input([line({ adjustmentQty: new Prisma.Decimal(-120) })]), 1);

    expect(recorded.posted[0].lines[0].qty).toBe(120);
  });

  it('잔액 0행은 400 NEGATIVE_BALANCE · 2행+ 는 400 INVALID — 소유 축을 고를 수 없다', async () => {
    const { tx: empty, posting: p1 } = fake({ balances: [] });
    expect(((await thrown(() => postAdjustment(empty, p1, input([line()]), 1))) as ContractException).errors[0]).toMatchObject({
      field: 'lines[0].locationId',
      code: 'NEGATIVE_BALANCE',
    });

    const { tx: dual, posting: p2 } = fake({ balances: [balance(), balance()] });
    expect(((await thrown(() => postAdjustment(dual, p2, input([line()]), 1))) as ContractException).errors[0]).toMatchObject({
      field: 'lines[0].locationId',
      code: 'INVALID',
    });
  });

  it('⭐ 같은 (위치·품목·LOT) 라인 둘은 «합»으로 본다 — 라인별로 보면 둘 다 통과하고 UPDATE 가 500 이다', async () => {
    const { tx, posting } = fake();

    const error = await thrown(() =>
      postAdjustment(
        tx,
        posting,
        input([
          line({ adjustmentQty: new Prisma.Decimal(-60) }),
          line({ inventoryAdjustmentLineId: 901n, adjustmentQty: new Prisma.Decimal(-60) }),
        ]),
        1,
      ),
    );

    // 오류가 짚는 자리는 그 키를 «처음» 쓴 라인이다.
    expect((error as ContractException).errors).toHaveLength(1);
    expect((error as ContractException).errors[0]).toMatchObject({ field: 'lines[0].adjustmentQty' });
  });
});

describe('postAdjustment — 자물쇠와 되짚기', () => {
  it('⭐ 잔액을 `inventory_balance_id` 오름차순으로 `FOR UPDATE` 잠근다 — 7칸 행생성자 한 문장이다', async () => {
    const { tx, posting, recorded } = fake();

    await postAdjustment(tx, posting, input([line()]), 1);

    // ⛔ 잠금이 사라지거나 `FOR SHARE` 로 낮아지면 같은 순간의 두 전기가 잔액을 두 번 움직인다.
    //    e2e 로는 경쟁을 못 재므로 원시 SQL 을 이 단언이 지켜본다(`stock-transfer-lock.spec.ts` 선례).
    expect(recorded.lockSql).toContain('FOR UPDATE');
    expect(recorded.lockSql).toContain('ORDER BY inventory_balance_id');
    expect(recorded.lockSql).toContain('inventory.inventory_balance');
    expect(recorded.lockSql).toContain(
      'WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,',
    );
  });

  it('⭐ 되짚기는 그 원장 헤더로 좁히고 `line_no` 오름차순으로 읽는다', async () => {
    const { tx, posting, recorded } = fake();

    await postAdjustment(tx, posting, input([line()]), 1);

    expect(recorded.ledgerArgs).toMatchObject({
      where: { inventory_transaction_id: 77n, business_date: new Date(`${DAY}T00:00:00.000Z`) },
      orderBy: { line_no: 'asc' },
    });
  });

  it('원장 라인 수가 조정 라인과 어긋나면 던진다 — 조용히 남의 원장을 가리키느니 되돌린다', async () => {
    const { tx, posting } = fake({ ledgerRows: 2 });

    const error = await thrown(() => postAdjustment(tx, posting, input([line()]), 1));

    expect((error as Error).message).toContain('원장 라인 수가 조정 라인과 다르다');
  });
});
