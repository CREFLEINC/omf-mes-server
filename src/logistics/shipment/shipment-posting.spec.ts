import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { ShipmentCreateWrite, ShipmentWrite, postShipment } from './shipment-posting';

/** ⭐ 표마다 값을 벌린다 — 다 같으면 칸을 뒤바꿔도 초록이다(README §6-3 ⑴). */
const SHIPMENT_ID = 90001n;
const ISSUE_ID = 70002n;
const REQUEST_ID = 401;
const REQUEST_LINE_ID = 402;
const WAREHOUSE_ID = 21;
const LOCATION_ID = 34;
const LOT_A = 501;
const LOT_B = 502;
const ITEM_A = 601n;
const ITEM_B = 602n;
const UOM_ID = 13;
const USER_ID = 9;
const SHIPMENT_NO = 'SH-20260910-0001';
const ISSUE_NO = 'GI-20260910-0001';
const DAY = '2026-09-10';
/** ⭐ 영업일과 «다른 날»의 시각이다 — 두 축을 섞으면 RED. */
const AT = '2026-09-12T02:00:00.000Z';

type Row = Record<string, unknown>;

type SqlFragment = { strings: readonly string[]; values: unknown[] };
const isFragment = (value: unknown): value is SqlFragment =>
  typeof value === 'object' && value !== null && Array.isArray((value as SqlFragment).values);

/**
 * ⭐ 중첩된 `Prisma.sql` 조각까지 펴서 «값»을 본다. `lockBalances` 는 키 전건을
 * `Prisma.join(...)` 한 «한 조각»으로 넘기므로, 안 펴면 bigint 가 하나도 안 보이고 가짜가
 * 0행을 내어 판정이 통째로 뭉개진다(첫 작성에서 실제로 그랬다).
 */
function flatValues(values: unknown[]): unknown[] {
  return values.flatMap((value) => (isFragment(value) ? flatValues(value.values) : [value]));
}

interface Recorded {
  order: string[];
  issue: Row[];
  issueLines: Row[];
  shipment: Row[];
  shipmentLines: Row[];
  allocations: Row[];
  posted: PostingInput[];
  consumed: unknown[];
}

interface Seed {
  /** LOT 별 잔액 행 수 — 0행·2행+ 판정을 흔든다. */
  balanceRows?: Record<number, number>;
  lotStatus?: Record<number, string>;
  missingLot?: number;
}

function fake(seed: Seed = {}): {
  tx: Prisma.TransactionClient;
  posting: InventoryPostingService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    order: [], issue: [], issueLines: [], shipment: [], shipmentLines: [],
    allocations: [], posted: [], consumed: [],
  };
  let issueLineSeq = 0n;
  let shipmentLineSeq = 0n;

  const tx = {
    lot: {
      findMany: ({ where }: { where: { lot_id: { in: bigint[] } } }) =>
        Promise.resolve(
          where.lot_id.in
            .filter((id) => Number(id) !== seed.missingLot)
            .map((id) => ({
              lot_id: id,
              item_id: Number(id) === LOT_A ? ITEM_A : ITEM_B,
              status_code: seed.lotStatus?.[Number(id)] ?? 'NORMAL',
            })),
        ),
    },
    judgment_type_control: { findFirst: () => Promise.resolve(null) },
    warehouse: {
      findUniqueOrThrow: () =>
        Promise.resolve({ business_unit_id: 2n, plant_id: 3n, plant: { legal_entity_id: 1n } }),
    },
    goods_issue: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('goods_issue.create');
        recorded.issue.push(data);
        return Promise.resolve({ goods_issue_id: ISSUE_ID });
      },
    },
    goods_issue_line: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('goods_issue_line.create');
        recorded.issueLines.push(data);
        issueLineSeq += 1n;
        return Promise.resolve({ goods_issue_line_id: 800000n + issueLineSeq });
      },
      update: () => {
        recorded.order.push('goods_issue_line.update');
        return Promise.resolve({});
      },
    },
    shipment: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('shipment.create');
        recorded.shipment.push(data);
        return Promise.resolve({ shipment_id: SHIPMENT_ID });
      },
    },
    shipment_line: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('shipment_line.create');
        recorded.shipmentLines.push(data);
        shipmentLineSeq += 1n;
        return Promise.resolve({ shipment_line_id: 900000n + shipmentLineSeq });
      },
    },
    shipment_lot_allocation: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('shipment_lot_allocation.create');
        recorded.allocations.push(data);
        return Promise.resolve({});
      },
    },
    inventory_transaction_line: {
      findMany: () =>
        Promise.resolve(
          recorded.issueLines.map((_, index) => ({ inventory_transaction_line_id: 1000n + BigInt(index) })),
        ),
    },
    /**
     * 잔액 잠금 — `lockBalancesByItemLot`(LOT 하나)과 `postIssue` 의 `lockBalances`(키 전건)가
     * 둘 다 이걸 탄다. ⭐ 뒤엣것은 «키마다» 한 행을 내야 한다 — 하나만 내면 둘째 LOT 이 0행이
     * 되어 판정이 뭉개진다.
     */
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const bulk = sql.includes('IN (VALUES');
      recorded.order.push(bulk ? 'lockBalances' : 'lockByItemLot');
      const seen = flatValues(values).filter(
        (value) => typeof value === 'bigint' && [LOT_A, LOT_B].includes(Number(value)),
      ) as bigint[];
      const lots = bulk ? [...new Set(seen.map(Number))] : [Number(seen[seen.length - 1] ?? LOT_A)];
      const rowOf = (lotId: number): Row => ({
        legalEntityId: 1n, businessUnitId: 2n, plantId: 3n,
        warehouseId: BigInt(WAREHOUSE_ID), locationId: BigInt(LOCATION_ID),
        itemId: lotId === LOT_A ? ITEM_A : ITEM_B,
        lotKey: BigInt(lotId), lotId: BigInt(lotId),
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED', owner_partner_id: null,
        available_qty: new Prisma.Decimal(1000),
      });
      return Promise.resolve(
        lots.flatMap((lotId) =>
          Array.from({ length: seed.balanceRows?.[lotId] ?? 1 }, () => rowOf(lotId)),
        ),
      );
    },
  } as unknown as Prisma.TransactionClient;

  const posting = {
    consume: (_tx: unknown, moves: unknown) => {
      recorded.order.push('posting.consume');
      recorded.consumed.push(moves);
      return Promise.resolve();
    },
    post: (_tx: unknown, posted: PostingInput) => {
      recorded.order.push('posting.post');
      recorded.posted.push(posted);
      return Promise.resolve({ inventoryTransactionId: 77n, businessDate: posted.businessDate, alreadyPosted: false });
    },
  } as unknown as InventoryPostingService;

  return { tx, posting, recorded };
}

const input = (over: Partial<ShipmentCreateWrite> = {}): ShipmentCreateWrite => ({
  shipmentRequestId: REQUEST_ID,
  warehouseId: WAREHOUSE_ID,
  businessDate: DAY,
  occurredAt: AT,
  lines: [
    {
      shipmentRequestLineId: REQUEST_LINE_ID,
      shippedQty: 10,
      uomId: UOM_ID,
      allocations: [{ lotId: LOT_A, allocatedQty: 10, uomId: UOM_ID }],
    },
  ],
  ...over,
});

const write = (over: Partial<ShipmentCreateWrite> = {}): ShipmentWrite => ({
  input: input(over),
  shipmentNo: SHIPMENT_NO,
  goodsIssueNo: ISSUE_NO,
  itemIdByLine: [ITEM_A, ITEM_B],
  appUserId: USER_ID,
});

const caught = async (run: () => Promise<unknown>): Promise<ContractException> => {
  try {
    await run();
  } catch (error) {
    return error as ContractException;
  }
  throw new Error('던지지 않았다');
};

describe('postShipment — 출하·출고 전표·원장이 한 트랜잭션이다', () => {
  it('⭐ 출고 전표를 «만든다» — 판별자가 원장 enum 5값 안에 들어가는 유일한 길(자리 ①)', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    expect(recorded.issue[0]).toMatchObject({
      goods_issue_no: ISSUE_NO,
      issue_type_code: 'SHIPMENT',
      source_document_type_code: 'SHIPMENT',
      // ⭐ 짝 id 는 «이 출하»다 — 초판은 여기에 출하작업지시 id 를 넣었고 이 단언이 그것을
      //   못 박고 있었다(유령 참조). A-10: 판별자 SHIPMENT 의 짝은 logistics.shipment 의 id.
      source_document_id: SHIPMENT_ID,
      source_warehouse_id: BigInt(WAREHOUSE_ID),
      status_code: 'POSTED',
    });
    // ⭐ 원장 쪽은 `GOODS_ISSUE` 다 — 전표의 원천 유형과 «다른 축»이다.
    expect(recorded.posted[0]).toMatchObject({
      sourceDocumentTypeCode: 'GOODS_ISSUE',
      sourceDocumentId: Number(ISSUE_ID),
      transactionNo: ISSUE_NO,
      businessDate: DAY,
    });
  });

  it('⛔ 영업일은 본문 값 그대로다 — 서버가 occurredAt 에서 도출하지 않는다(C-8)', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    // 두 축이 «다른 날»이라 섞으면 여기서 드러난다.
    expect(recorded.posted[0].businessDate).toBe(DAY);
    expect(recorded.posted[0].occurredAt).toEqual(new Date(AT));
  });

  it('⭐⭐ 피킹분을 «소진한다» — 안 하면 정상 출하가 언제나 400 이다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    // `CONSUMES_PICKED` 에 SHIPMENT 가 없으면 이 호출이 통째로 사라진다(변이 대상).
    expect(recorded.consumed).toHaveLength(1);
    expect(recorded.order.indexOf('posting.consume')).toBeLessThan(
      recorded.order.indexOf('posting.post'),
    );
  });

  it('⛔ 원장 라인에 from 만 있고 to 는 «없다» — 고객에게 나가 없어진다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    const line = recorded.posted[0].lines[0];
    expect(line.from).toMatchObject({ warehouseId: WAREHOUSE_ID, locationId: LOCATION_ID });
    expect(line).not.toHaveProperty('to');
  });

  it('⭐ 출하는 UNCONFIRMED 로 선다 — 계약이 「확정하지 않는다」로 못 박았다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    expect(recorded.shipment[0]).toMatchObject({
      shipment_no: SHIPMENT_NO,
      status_code: 'UNCONFIRMED',
      expedited: false,
    });
  });

  it('⭐ 되짚기 — shipment_line.goods_issue_line_id 가 자기 «첫» 출고 라인을 가리킨다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(
      tx,
      posting,
      write({
        lines: [
          {
            shipmentRequestLineId: REQUEST_LINE_ID,
            shippedQty: 10,
            uomId: UOM_ID,
            allocations: [
              { lotId: LOT_A, allocatedQty: 6, uomId: UOM_ID },
              { lotId: LOT_B, allocatedQty: 4, uomId: UOM_ID },
            ],
          },
          {
            shipmentRequestLineId: REQUEST_LINE_ID + 1,
            shippedQty: 5,
            uomId: UOM_ID,
            allocations: [{ lotId: LOT_A, allocatedQty: 5, uomId: UOM_ID }],
          },
        ],
      }),
    );

    // ⭐ 배분이 셋이라 출고 라인도 셋이다. 둘째 출하 라인은 «셋째» 출고 라인을 가리켜야 한다 —
    //   커서를 배분 수만큼 안 밀면 여기서 드러난다(둘 다 첫 줄을 가리킨다).
    expect(recorded.issueLines).toHaveLength(3);
    expect(recorded.shipmentLines.map((row) => row.goods_issue_line_id)).toEqual([
      800001n,
      800003n,
    ]);
    expect(recorded.allocations).toHaveLength(3);
  });

  it('⛔ Release 가 아닌 LOT 은 400 STATE_LOCKED — 전기 «전»에 막는다(결정 10)', async () => {
    const { tx, posting, recorded } = fake({ lotStatus: { [LOT_A]: 'DEFECTIVE' } });

    const failure = await caught(() => postShipment(tx, posting, write()));

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({
      field: 'lines[0].allocations[0].lotId',
      code: 'STATE_LOCKED',
    });
    // ⭐ 출하도 전표도 원장도 «안» 섰다 — 게이트가 맨 앞이다.
    expect(recorded.order).not.toContain('shipment.create');
    expect(recorded.order).not.toContain('goods_issue.create');
    expect(recorded.posted).toHaveLength(0);
  });

  it('⛔ 그 창고에 잔액 행이 0행이면 400 NEGATIVE_BALANCE 다', async () => {
    const { tx, posting } = fake({ balanceRows: { [LOT_A]: 0 } });

    const failure = await caught(() => postShipment(tx, posting, write()));

    expect(failure.errors[0]).toMatchObject({
      field: 'lines[0].allocations[0].lotId',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('⛔ 잔액 차원이 2행+ 면 400 INVALID — 계약이 품질·재고 상태 칸을 안 싣는다', async () => {
    const { tx, posting } = fake({ balanceRows: { [LOT_A]: 2 } });

    const failure = await caught(() => postShipment(tx, posting, write()));

    expect(failure.errors[0]).toMatchObject({
      field: 'lines[0].allocations[0].lotId',
      code: 'INVALID',
    });
  });

  it('⭐ 없는 LOT 은 400 INVALID 이고, 오류를 «전건» 모아 한 봉투로 던진다', async () => {
    const { tx, posting } = fake({ missingLot: LOT_B, balanceRows: { [LOT_A]: 0 } });

    const failure = await caught(() =>
      postShipment(
        tx,
        posting,
        write({
          lines: [
            {
              shipmentRequestLineId: REQUEST_LINE_ID,
              shippedQty: 10,
              uomId: UOM_ID,
              allocations: [
                { lotId: LOT_A, allocatedQty: 6, uomId: UOM_ID },
                { lotId: LOT_B, allocatedQty: 4, uomId: UOM_ID },
              ],
            },
          ],
        }),
      ),
    );

    expect(failure.errors.map((item) => item.field)).toEqual([
      'lines[0].allocations[0].lotId',
      'lines[0].allocations[1].lotId',
    ]);
  });

  it('⭐⭐ 출하 헤더가 출고 전표보다 «먼저» 선다 — 원천 id 가 그것이다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    expect(recorded.order.indexOf('shipment.create')).toBeLessThan(
      recorded.order.indexOf('goods_issue.create'),
    );
  });

  it('⭐ 잔액을 «먼저» 잠근 뒤에 쓴다 — 순서가 불변식이다', async () => {
    const { tx, posting, recorded } = fake();

    await postShipment(tx, posting, write());

    expect(recorded.order.indexOf('lockByItemLot')).toBeLessThan(
      recorded.order.indexOf('goods_issue.create'),
    );
  });
});
