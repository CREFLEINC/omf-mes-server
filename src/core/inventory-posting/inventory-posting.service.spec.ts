import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { InventoryPostingService } from './inventory-posting.service';
import { PostingInput, ReverseInput } from './posting.types';

const TX_ID = 4100n;
const DAY = '2026-09-06';
const AT = new Date('2026-09-06T02:00:00.000Z');
const LE = 1n;
const BU = 2n;
const PLANT = 3n;
const WH = 10n;
const LOC = 20n;
const ITEM = 30n;
const LOT = 40n;
const UOM = 5n;

type Row = Record<string, unknown>;

/** 원 라인 한 줄 — 기본은 「입고」(from 없음 · to 만 있다)라 역행이 그 자리에서 «나간다». */
function ledgerLine(over: Row = {}): Row {
  return {
    inventory_transaction_line_id: 900n,
    inventory_transaction_id: TX_ID,
    business_date: new Date(`${DAY}T00:00:00.000Z`),
    line_no: 1,
    item_id: ITEM,
    lot_id: LOT,
    qty: new Prisma.Decimal(100),
    uom_id: UOM,
    from_warehouse_id: null,
    from_location_id: null,
    from_quality_status_code: null,
    from_inventory_status_code: null,
    to_warehouse_id: WH,
    to_location_id: LOC,
    to_quality_status_code: 'NORMAL',
    to_inventory_status_code: 'AVAILABLE',
    ownership_type_code: 'OWNED',
    owner_partner_id: null,
    handling_unit_id: null,
    from_qty_after_transaction: null,
    to_qty_after_transaction: null,
    created_at: AT,
    created_by: null,
    ...over,
  };
}

function balanceRow(over: Row = {}): Row {
  return {
    legalEntityId: LE,
    businessUnitId: BU,
    plantId: PLANT,
    warehouseId: WH,
    locationId: LOC,
    itemId: ITEM,
    lotKey: LOT,
    quality_status_code: 'NORMAL',
    inventory_status_code: 'AVAILABLE',
    ownership_type_code: 'OWNED',
    owner_partner_id: null,
    available_qty: new Prisma.Decimal(500),
    ...over,
  };
}

type Seed = {
  lines?: Row[];
  balances?: Row[];
  /** 선조회가 차례로 낼 역행 헤더 — 경합 재현에 두 값이 필요하다. */
  reversals?: (Row | null)[];
  /** 헤더 INSERT 가 던질 것. */
  createError?: unknown;
};

/**
 * 「그 트랜잭션의 표」를 흉내낸다 — 어느 객체로 무엇을 썼는지가 이 스위트의 목이라
 * 호출을 부른 순서 그대로 담는다.
 */
function fake(seed: Seed = {}) {
  const calls: string[] = [];
  const args: Row[] = [];
  const raws: { sql: string; values: unknown[] }[] = [];
  const record =
    <T>(name: string, result: (a: Row) => T) =>
    async (a: Row) => {
      calls.push(name);
      args.push(a);
      return result(a);
    };
  let created = 0;
  const lines = seed.lines ?? [ledgerLine()];
  const reversals = [...(seed.reversals ?? [null])];

  const tx = {
    inventory_transaction: {
      findFirst: record('header.findFirst', () => reversals.shift() ?? null),
      findUniqueOrThrow: record('header.findUniqueOrThrow', () => ({
        transaction_no: 'GR-20260906-0001',
        transaction_type_code: 'GOODS_RECEIPT',
        plant_id: PLANT,
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: 77n,
        status_code: 'POSTED',
        inventory_transaction_line: lines,
      })),
      create: record('header.create', () => {
        if (seed.createError !== undefined) throw seed.createError;
        return { inventory_transaction_id: 9100n };
      }),
    },
    inventory_transaction_line: {
      create: record('line.create', () => ({ inventory_transaction_line_id: BigInt(++created) })),
    },
    warehouse: {
      findUniqueOrThrow: record('warehouse.findUniqueOrThrow', () => ({
        business_unit_id: BU,
        plant_id: PLANT,
        plant: { legal_entity_id: LE },
      })),
    },
    $executeRaw: async () => {
      calls.push('$executeRaw');
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      raws.push({ sql, values });
      calls.push(sql.includes('FOR UPDATE') ? 'lock' : 'move');
      if (sql.includes('FOR UPDATE')) return seed.balances ?? [balanceRow()];
      return [{ on_hand_qty: new Prisma.Decimal(400) }];
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    calls,
    args,
    raws,
    service: new InventoryPostingService(),
  };
}

const reverseInput = (over: Partial<ReverseInput> = {}): ReverseInput => ({
  inventoryTransactionId: TX_ID,
  businessDate: DAY,
  occurredAt: new Date('2026-09-07T01:00:00.000Z'),
  createdBy: 8,
  ...over,
});

const endpoint = (locationId: bigint) => ({
  warehouseId: Number(WH),
  locationId: Number(locationId),
  qualityStatusCode: 'NORMAL',
  inventoryStatusCode: 'AVAILABLE',
});

const postInput = (over: Partial<PostingInput> = {}): PostingInput => ({
  businessDate: DAY,
  occurredAt: AT,
  transactionTypeCode: 'GOODS_RECEIPT',
  transactionNo: 'GR-20260906-0001',
  statusCode: 'POSTED',
  plantId: Number(PLANT),
  sourceDocumentTypeCode: 'GOODS_RECEIPT',
  sourceDocumentId: 77,
  idempotencyKey: 'K-1',
  lines: [
    {
      itemId: Number(ITEM),
      lotId: Number(LOT),
      qty: 100,
      uomId: Number(UOM),
      ownershipTypeCode: 'OWNED',
      to: endpoint(LOC),
    },
  ],
  ...over,
});

/** 던진 `ContractException` 을 집어 온다 — 상태와 코드를 둘 다 봐야 하기 때문이다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

const lineData = (args: Row[]): Row => args.find((a) => 'data' in a && 'line_no' in (a.data as Row))?.data as Row;
const headerData = (args: Row[]): Row =>
  args.find((a) => 'data' in a && 'idempotency_key' in (a.data as Row))?.data as Row;

describe('역트랜잭션 코어', () => {
  it('reverse — from/to 를 뒤집어 새 원장 행을 만든다(수량은 그대로 양수다 · qty > 0 CHECK)', async () => {
    const { tx, args, service } = fake();

    await service.reverse(tx, reverseInput());

    const line = lineData(args);
    expect(line.qty).toBe(100);
    expect(line.from_warehouse_id).toBe(Number(WH));
    expect(line.from_location_id).toBe(Number(LOC));
    expect(line.to_warehouse_id).toBeUndefined();
  });

  it('reverse — 원 라인의 item·lot·uom·소유 칸을 그대로 복사한다', async () => {
    const { tx, args, service } = fake({
      lines: [ledgerLine({ owner_partner_id: 55n, handling_unit_id: 66n })],
      balances: [balanceRow({ owner_partner_id: 55n })],
    });

    await service.reverse(tx, reverseInput());

    expect(lineData(args)).toMatchObject({
      item_id: Number(ITEM),
      lot_id: Number(LOT),
      uom_id: Number(UOM),
      ownership_type_code: 'OWNED',
      owner_partner_id: 55,
      handling_unit_id: 66,
      line_no: 1,
    });
  });

  it('reverse — reversal_of_transaction_id 와 reversal_of_business_date 를 둘 다 채운다(ck_inventory_reversal_pair)', async () => {
    const { tx, args, service } = fake();

    await service.reverse(tx, reverseInput());

    const header = headerData(args);
    expect(header.reversal_of_transaction_id).toBe(TX_ID);
    expect(header.reversal_of_business_date).toEqual(new Date(DAY));
  });

  it('reverse — 역트랜잭션의 business_date 는 원 트랜잭션의 것이다(수신 시각으로 다시 잡지 않는다 · C-8)', async () => {
    const { tx, args, service } = fake();

    const result = await service.reverse(
      tx,
      reverseInput({ occurredAt: new Date('2026-12-31T23:00:00.000Z') }),
    );

    expect(result.businessDate).toBe(DAY);
    expect(headerData(args).business_date).toEqual(new Date(DAY));
    expect(headerData(args).occurred_at).toEqual(new Date('2026-12-31T23:00:00.000Z'));
  });

  it('reverse — transaction_no 는 원 번호에 -R 을 붙인다(uq_inventory_transaction_no 를 안 깬다)', async () => {
    const { tx, args, service } = fake();

    const result = await service.reverse(tx, reverseInput());

    expect(result.transactionNo).toBe('GR-20260906-0001-R');
    expect(headerData(args).transaction_no).toBe('GR-20260906-0001-R');
  });

  it('reverse — transaction_type_code·source_document_* 는 원 것을 복사한다(새 값을 짓지 않는다)', async () => {
    const { tx, args, service } = fake();

    await service.reverse(tx, reverseInput());

    expect(headerData(args)).toMatchObject({
      transaction_type_code: 'GOODS_RECEIPT',
      source_document_type_code: 'GOODS_RECEIPT',
      source_document_id: 77n,
      status_code: 'POSTED',
      plant_id: PLANT,
    });
  });

  it('reverse — 멱등키는 REVERSAL:{원 트랜잭션 id} 다', async () => {
    const { tx, args, service } = fake();

    await service.reverse(tx, reverseInput());

    expect(headerData(args).idempotency_key).toBe(`REVERSAL:${TX_ID}`);
  });

  it('reverse — 이미 역처리된 원 트랜잭션은 키가 달라도 alreadyReversed:true 로 흡수한다', async () => {
    const { tx, calls, service } = fake({
      reversals: [
        {
          inventory_transaction_id: 8800n,
          transaction_no: 'GR-20260906-0001-REV',
          business_date: new Date(`${DAY}T00:00:00.000Z`),
        },
      ],
    });

    const result = await service.reverse(tx, reverseInput());

    expect(result).toEqual({
      inventoryTransactionId: 8800n,
      transactionNo: 'GR-20260906-0001-REV',
      businessDate: DAY,
      alreadyReversed: true,
    });
    expect(calls).toEqual(['header.findFirst']);
  });

  it('reverse — 경합으로 uq_inventory_idempotency 에 걸리면 되읽어 같은 응답이다', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6',
      meta: { target: 'uq_inventory_idempotency' },
    });
    // 선조회는 0행(경합 상대가 아직 안 들어왔다) · INSERT 실패 뒤 되읽기는 1행이다.
    const { tx, service } = fake({
      createError: conflict,
      reversals: [
        null,
        {
          inventory_transaction_id: 9999n,
          transaction_no: 'GR-20260906-0001-R',
          business_date: new Date(`${DAY}T00:00:00.000Z`),
        },
      ],
    });

    const result = await service.reverse(tx, reverseInput());

    expect(result).toEqual({
      inventoryTransactionId: 9999n,
      transactionNo: 'GR-20260906-0001-R',
      businessDate: DAY,
      alreadyReversed: true,
    });
  });

  it('reverse — 다른 유일 위반(uq_inventory_transaction_no)은 삼키지 않는다', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6',
      meta: { target: 'uq_inventory_transaction_no' },
    });
    const { tx, service } = fake({ createError: conflict });

    await expect(service.reverse(tx, reverseInput())).rejects.toBe(conflict);
  });

  it('reverse — 잔액 행은 from·to 7칸 키를 한 VALUES 문장으로 id 오름차순 잠근다(교차곱이 아니다)', async () => {
    const { tx, raws, calls, service } = fake({
      lines: [
        ledgerLine({
          from_warehouse_id: WH,
          from_location_id: 21n,
          from_quality_status_code: 'NORMAL',
          from_inventory_status_code: 'AVAILABLE',
        }),
      ],
    });

    await service.reverse(tx, reverseInput());

    const lock = raws.find((r) => r.sql.includes('FOR UPDATE'));
    expect(lock).toBeDefined();
    expect(lock?.sql).toContain('IN (VALUES');
    expect(lock?.sql).toContain('ORDER BY inventory_balance_id');
    // 두 끝을 «같은» 문장에 넣는다 — 7칸 × 2줄이라 값이 14 개다(교차곱이면 더 는다).
    expect((lock?.values[0] as Prisma.Sql).values).toHaveLength(14);
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('move'));
  });

  it('reverse — 같은 11칸 키의 라인이 둘이면 합계로 하한을 본다 · available_qty 가 null 이면 던진다', async () => {
    const two = [ledgerLine(), ledgerLine({ line_no: 2, qty: new Prisma.Decimal(60) })];
    const short = fake({
      lines: two,
      balances: [balanceRow({ available_qty: new Prisma.Decimal(150) })],
    });

    const failure = await thrown(() => short.service.reverse(short.tx, reverseInput()));
    expect(failure).toBeInstanceOf(ContractException);
    expect(failure.errors[0]).toMatchObject({ code: ERROR_CODE.NEGATIVE_BALANCE });

    const enough = fake({
      lines: two,
      balances: [balanceRow({ available_qty: new Prisma.Decimal(160) })],
    });
    await expect(enough.service.reverse(enough.tx, reverseInput())).resolves.toMatchObject({
      alreadyReversed: false,
    });

    const empty = fake({ lines: two, balances: [balanceRow({ available_qty: null })] });
    await expect(empty.service.reverse(empty.tx, reverseInput())).rejects.toThrow(
      /available_qty 가 비어 있다/,
    );
  });

  it('reverse — 되돌린 결과가 음수이거나 11칸 잔액 행이 0행이면 400 NEGATIVE_BALANCE 다', async () => {
    const none = fake({ balances: [] });
    const missing = await thrown(() => none.service.reverse(none.tx, reverseInput()));
    expect(missing.getStatus()).toBe(400);
    expect(missing.errors[0]).toMatchObject({ code: ERROR_CODE.NEGATIVE_BALANCE });

    // 11칸 중 품질상태만 다른 행은 «다른 차원»이라 하한을 못 채운다.
    const other = fake({ balances: [balanceRow({ quality_status_code: 'HOLD' })] });
    const mismatched = await thrown(() => other.service.reverse(other.tx, reverseInput()));
    expect(mismatched.errors[0]).toMatchObject({ code: ERROR_CODE.NEGATIVE_BALANCE });
  });
});

describe('재고 전기 — 잔액 선잠금', () => {
  it('post — 잔액을 id 오름차순으로 먼저 잠근다', async () => {
    const { tx, calls, raws, service } = fake();

    await service.post(tx, postInput());

    const lock = raws.find((r) => r.sql.includes('FOR UPDATE'));
    expect(lock?.sql).toContain('ORDER BY inventory_balance_id');
    // 첫 `move()` «앞»이라야 교착 창이 닫힌다 — 순서가 이 처방의 전부다(I-4 R-1 ② · I-5 R-5).
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('header.create'));
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('move'));
  });

  it('post — from·to 7칸 키를 한 VALUES 문장으로 잠근다(교차곱이 아니다)', async () => {
    const { tx, raws, service } = fake();

    await service.post(
      tx,
      postInput({
        lines: [
          {
            itemId: Number(ITEM),
            lotId: Number(LOT),
            qty: 100,
            uomId: Number(UOM),
            ownershipTypeCode: 'OWNED',
            from: endpoint(21n),
            to: endpoint(LOC),
          },
        ],
      }),
    );

    const lock = raws.find((r) => r.sql.includes('FOR UPDATE'));
    expect(lock?.sql).toContain('IN (VALUES');
    // 두 끝을 «같은» 문장에 넣는다 — 7칸 × 2줄이라 값이 14 개다(교차곱이면 더 는다).
    expect((lock?.values[0] as Prisma.Sql).values).toHaveLength(14);
  });

  it('post — 멱등 재전송은 잠그지도 만들지도 않는다', async () => {
    const { tx, calls, service } = fake();
    (tx as unknown as { inventory_transaction: Row }).inventory_transaction = {
      findFirst: async () => ({ inventory_transaction_id: 55n }),
    } as Row;

    const result = await service.post(tx, postInput());

    expect(result).toEqual({
      inventoryTransactionId: 55n,
      businessDate: DAY,
      alreadyPosted: true,
    });
    expect(calls).toEqual([]);
  });
});
