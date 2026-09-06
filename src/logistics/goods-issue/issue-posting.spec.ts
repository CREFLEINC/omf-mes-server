import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { DocumentStateService, TRANSITIONS } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { GoodsIssueLineWriteInput, PostIssueInput, postIssue } from './issue-posting';

const LE = 1n;
const BU = 2n;
const PLANT = 3n;
const WH = 10n;
const LOC = 20n;
const DEST_WH = 11n;
const DEST_LOC = 21n;
const ITEM = 30n;
const LOT = 40n;
const UOM = 5n;
const ISSUE_ID = 700n;
const DAY = '2026-05-04';
const AT = new Date('2026-05-04T02:00:00.000Z');

type Row = Record<string, unknown>;

interface BalanceSeed extends Row {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  itemId: bigint;
  lotKey: bigint;
  quality_status_code: string;
  inventory_status_code: string;
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  available_qty: Prisma.Decimal | null;
}

const balance = (over: Partial<BalanceSeed> = {}): BalanceSeed => ({
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
  available_qty: new Prisma.Decimal(100),
  ...over,
});

const line = (over: Partial<GoodsIssueLineWriteInput> = {}): GoodsIssueLineWriteInput => ({
  goodsIssueLineId: 900n,
  itemId: ITEM,
  lotId: LOT,
  issueQty: new Prisma.Decimal(10),
  uomId: UOM,
  sourceLocationId: LOC,
  ...over,
});

interface Seed {
  balances?: BalanceSeed[];
  /** 원장이 되돌려 주는 라인 수 — 안 주면 요청 라인 수와 같다. */
  ledger?: number;
  absorbed?: boolean;
  lotStatuses?: string[];
  blocked?: boolean;
}

function fake(seed: Seed = {}) {
  const raws: { sql: string; values: unknown[] }[] = [];
  const backfilled: Row[] = [];
  const touched = new Set<string>();
  let requested = 0;

  const models: Row = {
    lot: {
      findMany: async () => (seed.lotStatuses ?? ['NORMAL']).map((status_code) => ({ status_code })),
    },
    judgment_type_control: {
      findFirst: async () => (seed.blocked === true ? { code_value_id: 1n } : null),
    },
    warehouse: {
      findUniqueOrThrow: async ({ where }: { where: { warehouse_id: bigint } }) => ({
        business_unit_id: BU,
        plant_id: where.warehouse_id === DEST_WH ? PLANT : PLANT,
        plant: { legal_entity_id: LE },
      }),
    },
    location: {
      findUniqueOrThrow: async () => ({ warehouse_id: DEST_WH }),
    },
    inventory_transaction_line: {
      findMany: async () =>
        Array.from({ length: seed.ledger ?? requested }, (_, index) => ({
          inventory_transaction_line_id: BigInt(5000 + index),
        })),
    },
    goods_issue_line: {
      update: async (args: Row) => void backfilled.push(args),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      raws.push({ sql: strings.join('?'), values });
      return seed.balances ?? [balance()];
    },
  };
  const tx = new Proxy(models, {
    get: (target: Row, prop: string | symbol) => (touched.add(String(prop)), target[String(prop)]),
  }) as unknown as Prisma.TransactionClient;

  const posted: PostingInput[] = [];
  const posting = {
    post: async (_tx: Prisma.TransactionClient, input: PostingInput) => {
      posted.push(input);
      requested = input.lines.length;
      return {
        inventoryTransactionId: 77n,
        businessDate: input.businessDate,
        alreadyPosted: seed.absorbed === true,
      };
    },
  } as unknown as InventoryPostingService;

  return { tx, posting, posted, raws, backfilled, touched };
}

const input = (over: Partial<PostIssueInput> = {}): PostIssueInput => ({
  header: {
    goodsIssueId: ISSUE_ID,
    goodsIssueNo: 'GI-20260504-0001',
    sourceWarehouseId: WH,
    destinationTypeCode: null,
    destinationId: null,
  },
  lines: [line()],
  businessDate: DAY,
  occurredAt: AT,
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

describe('출고 전기', () => {
  it('전기 — from 은 헤더 창고 + 라인 위치다', async () => {
    const { tx, posting, posted } = fake();

    await postIssue(tx, posting, input(), 1);

    expect(posted[0].lines[0].from).toEqual({
      warehouseId: Number(WH),
      locationId: Number(LOC),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    });
    // ⚠ 소유 축도 계약에 없어 잔액 행에서 되읽는다(§3-2).
    expect(posted[0].lines[0].ownershipTypeCode).toBe('OWNED');
    expect(posted[0].lines[0]).not.toHaveProperty('ownerPartnerId');
  });

  it('전기 — to 는 destinationTypeCode 가 LOCATION 일 때만 실린다', async () => {
    const { tx, posting, posted } = fake({
      balances: [balance(), balance({ warehouseId: DEST_WH, locationId: DEST_LOC })],
    });

    await postIssue(
      tx,
      posting,
      input({
        header: {
          goodsIssueId: ISSUE_ID,
          goodsIssueNo: 'GI-20260504-0001',
          sourceWarehouseId: WH,
          destinationTypeCode: 'LOCATION',
          destinationId: DEST_LOC,
        },
      }),
      1,
    );

    // 도착 두 칸은 `from` 과 같은 값이다 — 상태가 바뀌는 축이 계약에 없다.
    expect(posted[0].lines[0].to).toEqual({
      warehouseId: Number(DEST_WH),
      locationId: Number(DEST_LOC),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    });
  });

  it('전기 — PARTNER·DISPOSAL_SITE·비움이면 to 가 없다(출고다)', async () => {
    for (const destinationTypeCode of ['PARTNER', 'DISPOSAL_SITE', null]) {
      const { tx, posting, posted } = fake();

      await postIssue(
        tx,
        posting,
        input({
          header: {
            goodsIssueId: ISSUE_ID,
            goodsIssueNo: 'GI-20260504-0001',
            sourceWarehouseId: WH,
            destinationTypeCode,
            destinationId: destinationTypeCode === null ? null : 55n,
          },
        }),
        1,
      );

      expect(posted[0].lines[0]).not.toHaveProperty('to');
    }
  });

  it('전기 — 잔액 행이 0건이면 400 NEGATIVE_BALANCE 다(트리거가 500 으로 새지 않는다)', async () => {
    const { tx, posting, posted } = fake({ balances: [] });

    const error = await thrown(() => postIssue(tx, posting, input(), 1));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      errors: [{ field: 'lines[0].lotId', code: ERROR_CODE.NEGATIVE_BALANCE }],
    });
    // 원장을 열지 않았다 — 검사가 posting 앞이다.
    expect(posted).toHaveLength(0);
  });

  it('전기 — available_qty 보다 많이 내면 400 NEGATIVE_BALANCE 다(예약이 걸린 재고를 잠식하지 않는다)', async () => {
    // `on_hand` 는 100 인데 예약·피킹이 물려 가용이 9 다 — `on_hand` 만 보면 트리거가 500 을 낸다.
    const { tx, posting } = fake({ balances: [balance({ available_qty: new Prisma.Decimal(9) })] });

    const error = await thrown(() => postIssue(tx, posting, input(), 1));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      errors: [{ field: 'lines[0].issueQty', code: ERROR_CODE.NEGATIVE_BALANCE }],
    });
  });

  it('전기 — 잔액 차원이 둘 이상이면 400 INVALID 다(어느 것을 낼지 정하지 않는다)', async () => {
    const { tx, posting } = fake({
      balances: [balance(), balance({ quality_status_code: 'DEFECTIVE' })],
    });

    const error = await thrown(() => postIssue(tx, posting, input(), 1));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      errors: [{ field: 'lines[0].lotId', code: ERROR_CODE.INVALID }],
    });
  });

  it('전기 — item.negative_stock_allowed 가 참이어도 막는다', async () => {
    const { tx, posting, touched } = fake({
      balances: [balance({ available_qty: new Prisma.Decimal(1) })],
    });

    const error = await thrown(() => postIssue(tx, posting, input(), 1));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // 품목 표를 «읽지도» 않는다 — 계약 「보유 수량 이하」에 예외가 없다(§3-3 · §8-1 ⓓ).
    expect(touched.has('item')).toBe(false);
  });

  it('전기 — 수량 비교를 Decimal 로 한다(끝자리에서 판정이 안 갈린다)', async () => {
    // 0.1 + 0.2 를 배정도로 더하면 0.30000000000000004 라 가용 0.3 을 넘겨 잘못 막는다.
    const { tx, posting, posted } = fake({
      balances: [balance({ available_qty: new Prisma.Decimal('0.3') })],
    });

    await postIssue(
      tx,
      posting,
      input({
        lines: [
          line({ goodsIssueLineId: 900n, issueQty: new Prisma.Decimal('0.1') }),
          line({ goodsIssueLineId: 901n, issueQty: new Prisma.Decimal('0.2') }),
        ],
      }),
      1,
    );

    expect(posted).toHaveLength(1);
  });

  it('전기 — 잔액을 inventory_balance_id 오름차순 한 문장으로 잠근다(교착 회피)', async () => {
    const { tx, posting, raws } = fake();

    await postIssue(tx, posting, input({ lines: [line(), line({ goodsIssueLineId: 901n })] }), 1);

    expect(raws).toHaveLength(1);
    expect(raws[0].sql).toContain('ORDER BY inventory_balance_id');
    expect(raws[0].sql).toContain('FOR UPDATE');
  });

  it('전기 — 잔액 잠금은 7칸 행생성자 한 문장이다(교차곱이 아니다)', async () => {
    const { tx, posting, raws } = fake();

    await postIssue(tx, posting, input(), 1);

    const columns = raws[0].sql.replace(/\s+/g, ' ');
    expect(columns).toContain(
      'WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, COALESCE(lot_id, 0)) IN (VALUES',
    );
    // ⛔ `= ANY(…)` 두 줄이면 라인 1 의 위치와 라인 2 의 LOT 이 짝지어진다(I-4.md R-1 ①).
    expect(columns).not.toContain('= ANY');
  });

  it('전기 — to 가 LOCATION 이면 도착 차원도 같은 문장으로 잠근다', async () => {
    const { tx, posting, raws } = fake({
      balances: [balance(), balance({ warehouseId: DEST_WH, locationId: DEST_LOC })],
    });

    await postIssue(
      tx,
      posting,
      input({
        header: {
          goodsIssueId: ISSUE_ID,
          goodsIssueNo: 'GI-20260504-0001',
          sourceWarehouseId: WH,
          destinationTypeCode: 'LOCATION',
          destinationId: DEST_LOC,
        },
      }),
      1,
    );

    // 문장은 여전히 하나 — 도착 키가 같은 VALUES 목록에 붙는다(라인 1건 × 7칸 × 2 = 14).
    expect(raws).toHaveLength(1);
    const bound = (raws[0].values[0] as Prisma.Sql).values;
    expect(bound).toHaveLength(14);
    expect(bound).toContain(DEST_LOC);
  });

  it('전기 — 같은 위치·LOT 라인이 둘이면 합계로 검사한다', async () => {
    // 6 + 6 = 12 > 10. 라인별로 보면 둘 다 통과하고 둘째 UPDATE 에서 트리거가 500 이다.
    const { tx, posting } = fake({ balances: [balance({ available_qty: new Prisma.Decimal(10) })] });

    const error = await thrown(() =>
      postIssue(
        tx,
        posting,
        input({
          lines: [
            line({ goodsIssueLineId: 900n, issueQty: new Prisma.Decimal(6) }),
            line({ goodsIssueLineId: 901n, issueQty: new Prisma.Decimal(6) }),
          ],
        }),
        1,
      ),
    );

    expect(error.getResponse()).toMatchObject({
      errors: [{ field: 'lines[0].issueQty', code: ERROR_CODE.NEGATIVE_BALANCE }],
    });
  });

  it('전기 — available_qty 가 null 이면 던진다', async () => {
    // 생성 컬럼인데 Prisma 타입이 `Decimal?` 다 — 조용히 0 으로 두면 재고를 지어낸다.
    const { tx, posting } = fake({ balances: [balance({ available_qty: null })] });

    await expect(postIssue(tx, posting, input(), 1)).rejects.toThrow('available_qty');
  });

  it('전기 — 코어가 멱등키로 흡수하면 던져 되돌린다(잔액 없이 되짚기가 돌지 않는다)', async () => {
    const { tx, posting, backfilled } = fake({ absorbed: true });

    await expect(postIssue(tx, posting, input(), 1)).rejects.toThrow('원장이 이미 있다');
    expect(backfilled).toHaveLength(0);
  });

  it('전기 — 원장 라인 수가 출고 라인과 다르면 던져 되돌린다', async () => {
    const { tx, posting } = fake({ ledger: 0 });

    await expect(postIssue(tx, posting, input(), 1)).rejects.toThrow('원장 라인 수가');
  });

  it('전기 — sourceDocumentTypeCode 는 원장에서 GOODS_ISSUE 다(전표의 원천 유형이 아니다)', async () => {
    const { tx, posting, posted } = fake();

    await postIssue(tx, posting, input(), 1);

    expect(posted[0]).toMatchObject({
      sourceDocumentTypeCode: 'GOODS_ISSUE',
      transactionTypeCode: 'GOODS_ISSUE',
      transactionNo: 'GI-20260504-0001',
      idempotencyKey: 'GOODS_ISSUE:GI-20260504-0001',
      sourceDocumentId: Number(ISSUE_ID),
    });
  });

  it('전기 — businessDate·occurredAt 은 본문 값 그대로다(서버가 다시 잡지 않는다)', async () => {
    const { tx, posting, posted } = fake();

    await postIssue(tx, posting, input(), 1);

    expect(posted[0].businessDate).toBe(DAY);
    expect(posted[0].occurredAt).toBe(AT);
  });

  it('전기 — judgment_type_control 에 blocks_issue 행이 있으면 400 STATE_LOCKED 다', async () => {
    const { tx, posting, posted } = fake({ lotStatuses: ['SCRAPPED'], blocked: true });

    const error = await thrown(() => postIssue(tx, posting, input(), 1));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      errors: [{ code: ERROR_CODE.STATE_LOCKED }],
    });
    expect(posted).toHaveLength(0);
  });

  it('전기 — LOT 상태 문자열 집합을 코드에 박지 않는다(통제표가 비면 통과한다)', async () => {
    // 오늘의 실측 — `JUDGMENT_TYPE` 값 0개라 `judgment_type_control` 이 0행이다(I-4.md §5-3).
    const { tx, posting, posted } = fake({ lotStatuses: ['SCRAPPED', 'DEFECTIVE'], blocked: false });

    await postIssue(tx, posting, input(), 1);

    expect(posted).toHaveLength(1);
  });

  it('상태 — document-post 가 transitions.ts 에 등록돼 있다(미등록이면 던진다)', () => {
    expect(TRANSITIONS['logistics.goods_issue.status_code']['document-post']).toMatchObject({
      from: ['REGISTERED'],
      to: 'POSTED',
      sourceOperation: 'POST /logistics/goods-issues/{goodsIssueId}:post',
    });
  });

  it('상태 — REGISTERED 가 아니면 400 STATE_LOCKED 다(409 가 아니다)', () => {
    const state = new DocumentStateService();

    let caught: ContractException | undefined;
    try {
      state.assertTransition(
        'logistics.goods_issue.status_code',
        'document-post',
        'POSTED',
        HttpStatus.BAD_REQUEST,
      );
    } catch (error) {
      caught = error as ContractException;
    }

    expect(caught?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(caught?.getResponse()).toMatchObject({
      errors: [{ code: ERROR_CODE.STATE_LOCKED }],
    });
  });
});
