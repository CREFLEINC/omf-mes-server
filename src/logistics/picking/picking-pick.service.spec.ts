import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InventoryPostingService, PickMove } from '../../core/inventory-posting';
import { PrismaService } from '../../prisma/prisma.service';
import { PickingLinePick, PickingPickService } from './picking-pick.service';
import { PickingQueryService } from './picking-query.service';

const ORDER = 500;
const LINE = 900;
const LOT = 40n;
const ITEM = 30n;
const LOC = 20n;
const WH = 10n;
const DAY = '2026-05-04';
const AT = '2026-05-04T02:00:00.000Z';

type Row = Record<string, unknown>;

const balanceRow = (over: Row = {}): Row => ({
  legalEntityId: 1n,
  businessUnitId: 2n,
  plantId: 3n,
  warehouseId: WH,
  locationId: LOC,
  itemId: ITEM,
  lotKey: LOT,
  lotId: LOT,
  quality_status_code: 'NORMAL',
  inventory_status_code: 'AVAILABLE',
  ownership_type_code: 'OWNED',
  owner_partner_id: null,
  available_qty: new Prisma.Decimal(100),
  ...over,
});

interface Seed {
  line?: Row | undefined;
  balances?: Row[];
  /** 등록이 아닌 출고 라인이 걸려 있나 — R-14 의 축이다. */
  issuedLine?: boolean;
  held?: boolean;
  blocked?: boolean;
}

function fake(seed: Seed = {}) {
  const picks: PickMove[][] = [];
  const updates: Row[] = [];
  const issuedWhere: Row[] = [];

  const line: Row | undefined =
    seed.line === undefined
      ? {
          picking_line_id: BigInt(LINE),
          item_id: ITEM,
          lot_id: LOT,
          location_id: LOC,
          planned_qty: new Prisma.Decimal(10),
          picked_qty: new Prisma.Decimal(0),
          inventory_reservation_id: null,
          version_no: 1,
          warehouse_id: WH,
        }
      : seed.line;

  const tx: Row = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      // 잔액 잠금과 라인 잠금이 같은 문으로 오므로 표 이름으로 가른다.
      if (sql.includes('inventory_balance')) return seed.balances ?? [balanceRow()];
      return line === undefined ? [] : [line];
    },
    goods_issue_line: {
      findFirst: async (args: Row) => {
        issuedWhere.push(args.where as Row);
        return seed.issuedLine === true ? { goods_issue_line_id: 1n } : null;
      },
    },
    lot_hold: {
      findFirst: async () => (seed.held === true ? { lot_hold_id: 1n } : null),
    },
    lot: { findUniqueOrThrow: async () => ({ status_code: 'NORMAL' }) },
    judgment_type_control: {
      findFirst: async () => (seed.blocked === true ? { code_value_id: 1n } : null),
    },
    warehouse: {
      findUniqueOrThrow: async () => ({
        business_unit_id: 2n,
        plant_id: 3n,
        plant: { legal_entity_id: 1n },
      }),
    },
    picking_line: { update: async (args: Row) => void updates.push(args) },
  };

  const prisma = {
    $transaction: async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
  } as unknown as PrismaService;

  const posting = {
    pick: async (_tx: Prisma.TransactionClient, moves: PickMove[]) => void picks.push(moves),
  } as unknown as InventoryPostingService;

  const queries = {
    get: async () => ({ pickingOrder: {}, lines: [{ pickingLineId: LINE, pickedQty: 7 }] }),
  } as unknown as PickingQueryService;

  return { service: new PickingPickService(prisma, posting, queries), picks, updates, issuedWhere };
}

const body = (over: Partial<PickingLinePick> = {}): PickingLinePick => ({
  pickedQty: 7,
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});

const context = { workerNo: 'W-001', appUserId: 1 };

/** 던진 `ContractException` 을 집어 온다 — 상태와 코드를 둘 다 봐야 한다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

const codeOf = (error: ContractException): string =>
  (error.getResponse() as { errors: { code: string; field?: string }[] }).errors[0].code;

describe('라인 피킹 :pick', () => {
  it('blocks_picking 행이 없으면 통과한다(오늘의 데이터)', async () => {
    const { service, picks, updates } = fake();

    const view = await service.pick(ORDER, LINE, body(), context);

    expect(view).toMatchObject({ pickingLineId: LINE });
    // 통제표가 0행이라 ⑤ⓑ 는 아무것도 안 막는다 — 코어까지 그대로 간다.
    expect(picks[0][0]).toMatchObject({
      delta: new Prisma.Decimal(7),
      inventoryReservationId: null,
      field: 'pickedQty',
    });
    // ⚠ `lotKey` 가 아니라 실제 `lot_id` 를 넘긴다(R-3).
    expect(picks[0][0].dimension).toMatchObject({ lotId: LOT, itemId: ITEM, locationId: LOC });
    // 대체다 — 누계가 아니라 본문 값 그대로 넣는다(§6-4).
    expect(updates[0]).toMatchObject({
      data: expect.objectContaining({ picked_qty: new Prisma.Decimal(7) }),
    });
  });

  it('Δ 가 0 이면 코어를 부르지 않는다', async () => {
    const { service, picks, updates } = fake({
      line: {
        picking_line_id: BigInt(LINE),
        item_id: ITEM,
        lot_id: LOT,
        location_id: LOC,
        planned_qty: new Prisma.Decimal(10),
        picked_qty: new Prisma.Decimal(7),
        inventory_reservation_id: null,
        version_no: 1,
        warehouse_id: WH,
      },
    });

    await service.pick(ORDER, LINE, body(), context);

    expect(picks).toEqual([]);
    // 라인 UPDATE 는 돈다 — 같은 값을 다시 눌러도 `updated_by` 는 남는다.
    expect(updates).toHaveLength(1);
  });

  it('pickedQty 가 planned 를 넘으면 400 RANGE', async () => {
    const { service, picks } = fake();

    const error = await thrown(() => service.pick(ORDER, LINE, body({ pickedQty: 11 }), context));

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(codeOf(error)).toBe('RANGE');
    expect(picks).toEqual([]);
  });

  it('pickedQty 가 0 이면 400 RANGE', async () => {
    const { service } = fake();

    // 계약 `exclusiveMinimum: 0` — 0 으로 «지울» 수 없다(알려둘 것 ⓜ).
    const error = await thrown(() => service.pick(ORDER, LINE, body({ pickedQty: 0 }), context));

    expect(codeOf(error)).toBe('RANGE');
  });

  it('lotId 가 라인과 다르면 400 INVALID', async () => {
    const { service } = fake();

    const error = await thrown(() => service.pick(ORDER, LINE, body({ lotId: 99 }), context));

    expect(codeOf(error)).toBe('INVALID');
    expect(
      (error.getResponse() as { errors: { field?: string }[] }).errors[0].field,
    ).toBe('lotId');
  });

  it('미해제 lot_hold 면 400 STATE_LOCKED', async () => {
    const { service, picks } = fake({ held: true });

    const error = await thrown(() => service.pick(ORDER, LINE, body(), context));

    expect(codeOf(error)).toBe('STATE_LOCKED');
    expect(picks).toEqual([]);
  });

  it('이미 출고된 라인이면 400 STATE_LOCKED', async () => {
    const { service, picks } = fake({ issuedLine: true });

    const error = await thrown(() => service.pick(ORDER, LINE, body(), context));

    expect(codeOf(error)).toBe('STATE_LOCKED');
    expect(picks).toEqual([]);
  });

  it('등록만 된 출고는 라인을 막지 않는다', async () => {
    const { service, picks, issuedWhere } = fake();

    await service.pick(ORDER, LINE, body(), context);

    // R-14 — 축은 `status_code <> 'REGISTERED'` 다. 존재만으로 막으면 등록만 해 둔 출고가
    // 피킹 라인을 영구히 잠근다.
    expect(issuedWhere[0]).toEqual({
      picking_line_id: LINE,
      goods_issue: { status_code: { not: 'REGISTERED' } },
    });
    expect(picks).toHaveLength(1);
  });

  it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
    const { service, picks } = fake();

    for (const workerNo of [undefined, '  ']) {
      const error = await thrown(() => service.pick(ORDER, LINE, body(), { workerNo, appUserId: 1 }));
      expect(codeOf(error)).toBe('REQUIRED');
      expect(
        (error.getResponse() as { errors: { field?: string }[] }).errors[0].field,
      ).toBe('X-Worker-No');
    }
    // ⛔ 조회조차 하지 않는다 — 저장하지 않는 값이다(§6-7).
    expect(picks).toEqual([]);
  });

  it('잔액 차원이 2행이면 400 INVALID', async () => {
    const { service, picks } = fake({
      balances: [balanceRow(), balanceRow({ quality_status_code: 'HOLD' })],
    });

    const error = await thrown(() => service.pick(ORDER, LINE, body(), context));

    // 출고(`issue-posting.ts:126-129`)와 «같은 문장·같은 코드»다(문의 031 · R-16).
    expect(codeOf(error)).toBe('INVALID');
    expect(
      (error.getResponse() as { errors: { message: string }[] }).errors[0].message,
    ).toBe('재고 차원이 둘 이상이라 어느 것을 낼지 정할 수 없습니다.');
    expect(picks).toEqual([]);
  });
});
