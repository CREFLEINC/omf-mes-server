import { Prisma } from '@prisma/client';

import { InventoryPostingService } from './inventory-posting.service';
import { PostingInput } from './posting.types';

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
  balances?: Row[];
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

  const tx = {
    inventory_transaction: {
      findFirst: record('header.findFirst', () => null),
      create: record('header.create', () => ({ inventory_transaction_id: 9100n })),
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
