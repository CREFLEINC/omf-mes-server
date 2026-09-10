import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { LotHoldService, LotQualityStatusService } from '../../core/lot';
import {
  ReinstatementDeps,
  ReinstatementWrite,
  StockReinstatementCreate,
  postStockReinstatement,
} from './stock-reinstatement-posting';

/** ⭐ 값을 벌린다 — LOT·결정·보류·창고·위치 id 가 같으면 칸을 뒤바꿔도 초록이다. */
const LOT = 1101n;
const ITEM = 1202n;
const DECISION = 1303;
const HOLD = 1404n;
const DEFECT_WH = 1505n;
const DEFECT_LOC = 1606n;
const TARGET_WH = 1707;
const TARGET_LOC = 1808n;
const UOM = 13;
const USER = 9;
const VERSION = 4;
const TRANSFER = 5001n;
const TRANSFER_LINE = 6001n;
const LEDGER_LINE = 7001n;
const DAY = '2026-09-03';
/** ⭐ 영업일과 «다른 날»의 시각 — 두 축을 섞으면 RED. */
const AT = '2026-09-05T02:00:00.000Z';

type Row = Record<string, unknown>;

interface Seed {
  version?: number;
  disposition?: string;
  inDecision?: boolean;
  decisionUom?: number;
  decisionQty?: number;
  reinstated?: number | null;
  hold?: { lot_id?: bigint; hold_qty?: number | null; released?: boolean } | null;
  otherOpen?: number;
  defectRows?: number;
  available?: number;
  sourceLocation?: bigint;
  openAfter?: number;
  skipMove?: boolean;
  alreadyPosted?: boolean;
  afterStatus?: string;
}

function build(seed: Seed = {}) {
  const order: string[] = [];
  const posted: PostingInput[] = [];
  const created: Row[] = [];
  const lineUpdates: Row[] = [];
  const releases: { target: Row; input: Row }[] = [];
  const moves: { action: string; ctx: Row }[] = [];
  const holdQty = seed.hold === undefined ? 10 : seed.hold?.hold_qty;

  const tx = {
    disposition_decision: {
      findUnique: () => {
        order.push('decision');
        return Promise.resolve({
          disposition_type_code: seed.disposition ?? 'NORMAL',
          decision_qty: new Prisma.Decimal(seed.decisionQty ?? 10),
          uom_id: BigInt(seed.decisionUom ?? UOM),
          nonconformance: { nonconformance_lot: seed.inDecision === false ? [{ lot_id: 9999n }] : [{ lot_id: LOT }] },
        });
      },
    },
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('sum(')) {
        order.push('sumReinstated');
        return Promise.resolve([{ reinstated: seed.reinstated == null ? null : new Prisma.Decimal(seed.reinstated) }]);
      }
      order.push('lockBalances');
      return Promise.resolve(
        Array.from({ length: seed.defectRows ?? 1 }, (_, index) => ({
          warehouseId: DEFECT_WH,
          locationId: index === 0 ? (seed.sourceLocation ?? DEFECT_LOC) : DEFECT_LOC + 1n,
          lotId: LOT,
          quality_status_code: 'DEFECTIVE',
          inventory_status_code: 'AVAILABLE',
          ownership_type_code: 'OWNED',
          owner_partner_id: null,
          available_qty: new Prisma.Decimal(seed.available ?? 10),
        })),
      );
    },
    lot_hold: {
      findUnique: () => {
        order.push('hold');
        if (seed.hold === null) return Promise.resolve(null);
        return Promise.resolve({
          lot_hold_id: HOLD,
          lot_id: seed.hold?.lot_id ?? LOT,
          hold_qty: holdQty === null || holdQty === undefined ? null : new Prisma.Decimal(holdQty),
          released_at: seed.hold?.released === true ? new Date('2026-09-02T00:00:00.000Z') : null,
        });
      },
      count: () => Promise.resolve(seed.otherOpen ?? 0),
      findFirst: () => Promise.resolve({ hold_qty: new Prisma.Decimal(6) }),
    },
    lot: {
      findUniqueOrThrow: () => Promise.resolve({ item_id: ITEM, status_code: seed.afterStatus ?? 'NORMAL' }),
    },
    warehouse: {
      findMany: () =>
        Promise.resolve([{ warehouse_id: DEFECT_WH, is_defect: true, plant_id: 31n, business_unit_id: 41n }]),
    },
    stock_transfer: {
      create: ({ data }: { data: Row }) => {
        order.push('transfer.create');
        created.push(data);
        return Promise.resolve({ stock_transfer_id: TRANSFER, stock_transfer_line: [{ stock_transfer_line_id: TRANSFER_LINE }] });
      },
    },
    inventory_transaction_line: {
      findMany: () => Promise.resolve([{ inventory_transaction_line_id: LEDGER_LINE }]),
    },
    stock_transfer_line: {
      update: (args: Row) => {
        order.push('line.update');
        lineUpdates.push(args);
        return Promise.resolve({});
      },
    },
  } as unknown as Prisma.TransactionClient;

  const holds = {
    lockLotsWithin: () => {
      order.push('lockLot');
      return Promise.resolve([{ lot_id: LOT, status_code: 'DEFECTIVE', version_no: seed.version ?? VERSION }]);
    },
    releaseWithin: (_tx: unknown, _locked: unknown, target: Row, input: Row) => {
      order.push('release');
      releases.push({ target, input });
      const partial = input.releaseQty !== undefined;
      return Promise.resolve({ released: [], openAfter: seed.openAfter ?? (partial ? 1 : 0) });
    },
  } as unknown as LotHoldService;
  const lots = {
    moveWithin: (_tx: unknown, lotIds: bigint[], action: string, ctx: Row) => {
      order.push('move');
      moves.push({ action, ctx });
      return Promise.resolve({ movedLotIds: seed.skipMove === true ? [] : lotIds, skippedLotIds: [] });
    },
  } as unknown as LotQualityStatusService;
  const posting = {
    post: (_tx: unknown, input: PostingInput) => {
      order.push('post');
      posted.push(input);
      return Promise.resolve({ inventoryTransactionId: 77n, businessDate: input.businessDate, alreadyPosted: seed.alreadyPosted === true });
    },
  } as unknown as InventoryPostingService;

  const deps: ReinstatementDeps = { posting, holds, lots };
  return { tx, deps, order, posted, created, lineUpdates, releases, moves };
}

const body = (over: Partial<StockReinstatementCreate> = {}): StockReinstatementCreate => ({
  dispositionDecisionId: DECISION,
  lot: { lotId: Number(LOT), versionNo: VERSION },
  lotHoldId: Number(HOLD),
  toWarehouseId: TARGET_WH,
  qty: 10,
  uomId: UOM,
  releaseReasonCode: 'RETEST_PASS',
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});

const write = (over: Partial<StockReinstatementCreate> = {}): ReinstatementWrite => ({
  body: body(over),
  target: { warehouseId: TARGET_WH, plantId: 32n, businessUnitId: 42n, locationId: TARGET_LOC },
  transferNo: 'ST-20260903-0001',
  appUserId: USER,
});

async function caught<T>(run: () => Promise<unknown>): Promise<T> {
  try {
    await run();
  } catch (error) {
    return error as T;
  }
  throw new Error('던지지 않았다');
}

describe('postStockReinstatement — 한 트랜잭션', () => {
  it('⭐⭐ 순서가 불변식이다 — 잠금 → 판정 → 출발 잔액 → 이동 문서 → 원장 → 되짚기 → 해제 → 전이', async () => {
    const { tx, deps, order } = build();

    await postStockReinstatement(tx, deps, write());

    expect(order).toEqual([
      'lockLot', 'decision', 'sumReinstated', 'hold', 'lockBalances',
      'transfer.create', 'post', 'line.update', 'release', 'move',
    ]);
  });

  it('⭐ 이동 문서 — DEFECT_RETURN · 도착 시각 채움 · 출발 불량창고·도착 창고 · 처분 결정 연결', async () => {
    const { tx, deps, created } = build();

    await postStockReinstatement(tx, deps, write());

    expect(created[0]).toMatchObject({
      transfer_type_code: 'DEFECT_RETURN',
      status_code: 'POSTED',
      from_warehouse_id: DEFECT_WH,
      to_warehouse_id: BigInt(TARGET_WH),
      from_business_unit_id: 41n,
      to_business_unit_id: 42n,
      received_at: new Date(AT),
      disposition_decision_id: BigInt(DECISION),
    });
  });

  it('⭐⭐ 원장 «한 건 · 라인 한 줄» — from 불량 · to 도착(NORMAL/AVAILABLE) · 출발 공장 · 본문 영업일', async () => {
    const { tx, deps, posted } = build();

    await postStockReinstatement(tx, deps, write());

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      businessDate: DAY,
      occurredAt: new Date(AT),
      plantId: 31,
      sourceDocumentTypeCode: 'STOCK_TRANSFER',
      sourceDocumentId: Number(TRANSFER),
      idempotencyKey: 'STOCK_TRANSFER:ST-20260903-0001',
    });
    expect(posted[0].lines).toHaveLength(1);
    expect(posted[0].lines[0]).toMatchObject({
      from: { warehouseId: Number(DEFECT_WH), locationId: Number(DEFECT_LOC), qualityStatusCode: 'DEFECTIVE' },
      to: { warehouseId: TARGET_WH, locationId: Number(TARGET_LOC), qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE' },
    });
  });

  it('⭐ 반출·도착 되짚기 두 칸에 «같은» 원장 라인 id', async () => {
    const { tx, deps, lineUpdates } = build();

    await postStockReinstatement(tx, deps, write());

    expect(lineUpdates[0]).toMatchObject({
      where: { stock_transfer_line_id: TRANSFER_LINE },
      data: { issue_transaction_line_id: LEDGER_LINE, receipt_transaction_line_id: LEDGER_LINE },
    });
  });

  it('전량 — 도착을 NORMAL 로 담고 stock-reinstate 전이를 이 이동 문서 원천으로 부른다 · 잔량 null', async () => {
    const { tx, deps, releases, moves } = build();

    const view = await postStockReinstatement(tx, deps, write());

    expect(releases[0].input).toMatchObject({ releaseReasonCode: 'RETEST_PASS', releaseTargetLotStatusCode: 'NORMAL' });
    expect(releases[0].input).not.toHaveProperty('releaseQty');
    expect(moves[0]).toMatchObject({ action: 'stock-reinstate', ctx: { sourceDocumentTypeCode: 'STOCK_TRANSFER', sourceDocumentId: TRANSFER } });
    expect(view).toMatchObject({ lotStatusCode: 'NORMAL', remainingHeldQty: null, releasedLotHoldId: Number(HOLD) });
  });

  it('⭐⭐ 부분 — releaseQty 를 넘기고 도착을 «비우고» 전이를 안 부른다 · 상태는 다시 읽고 잔량을 싣는다(R-4)', async () => {
    const { tx, deps, releases, moves } = build({ afterStatus: 'DEFECTIVE' });

    const view = await postStockReinstatement(tx, deps, write({ qty: 4 }));

    expect(releases[0].input).toMatchObject({ releaseQty: new Prisma.Decimal(4) });
    expect(releases[0].input).not.toHaveProperty('releaseTargetLotStatusCode');
    expect(moves).toHaveLength(0);
    expect(view).toMatchObject({ lotStatusCode: 'DEFECTIVE', remainingHeldQty: 6, reinstatedQty: 4 });
  });

  it('⛔ 토큰이 낡으면 409 VERSION_CONFLICT — 결정을 읽기도 «전»이다', async () => {
    const { tx, deps, order } = build({ version: VERSION + 3 });

    const failure = await caught<ConflictException>(() => postStockReinstatement(tx, deps, write()));

    expect(failure.conflict).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: String(VERSION + 3) });
    expect(order).toEqual(['lockLot']);
  });

  it('⛔ 결정의 LOT 이 아니면 400 INVALID(lot.lotId) · 단위가 다르면 400 INVALID(uomId)', async () => {
    const notIn = await caught<ContractException>(() => { const b = build({ inDecision: false }); return postStockReinstatement(b.tx, b.deps, write()); });
    const uom = await caught<ContractException>(() => { const b = build({ decisionUom: UOM + 1 }); return postStockReinstatement(b.tx, b.deps, write()); });

    expect(notIn.errors[0]).toMatchObject({ field: 'lot.lotId', code: 'INVALID' });
    expect(uom.errors[0]).toMatchObject({ field: 'uomId', code: 'INVALID' });
  });

  it('⛔ 정상 처분이 아니면 409 DISPOSITION_NOT_REINSTATABLE', async () => {
    const { tx, deps } = build({ disposition: 'SCRAP' });

    expect((await caught<ConflictException>(() => postStockReinstatement(tx, deps, write()))).conflict.code).toBe(
      'DISPOSITION_NOT_REINSTATABLE',
    );
  });

  it('⛔ 보류 — 이미 풀렸으면 409 HOLD_ALREADY_RELEASED · 남의 LOT 보류면 400 INVALID(lotHoldId)', async () => {
    const released = await caught<ConflictException>(() => { const b = build({ hold: { released: true } }); return postStockReinstatement(b.tx, b.deps, write()); });
    const other = await caught<ContractException>(() => { const b = build({ hold: { lot_id: 9999n } }); return postStockReinstatement(b.tx, b.deps, write()); });

    expect(released.conflict.code).toBe('HOLD_ALREADY_RELEASED');
    expect(other.errors[0]).toMatchObject({ field: 'lotHoldId', code: 'INVALID' });
  });

  it('⛔ 불량창고 잔액 0행 → 409 INVALID_STATE · 2행+ → 400 RANGE · 모자라면 400 NEGATIVE_BALANCE', async () => {
    const none = await caught<ConflictException>(() => { const b = build({ defectRows: 0 }); return postStockReinstatement(b.tx, b.deps, write()); });
    const two = await caught<ContractException>(() => { const b = build({ defectRows: 2 }); return postStockReinstatement(b.tx, b.deps, write()); });
    const short = await caught<ContractException>(() => { const b = build({ available: 3 }); return postStockReinstatement(b.tx, b.deps, write()); });

    expect(none.conflict.code).toBe('INVALID_STATE');
    expect(two.errors[0]).toMatchObject({ field: 'lot.lotId', code: 'RANGE' });
    expect(short.errors[0]).toMatchObject({ field: 'qty', code: 'NEGATIVE_BALANCE' });
  });

  it('⛔ 출발과 도착 위치가 같으면 400 RANGE(toLocationId) — ck_stock_transfer_locations 를 앞당긴다', async () => {
    const { tx, deps, order } = build({ sourceLocation: TARGET_LOC });

    const failure = await caught<ContractException>(() => postStockReinstatement(tx, deps, write()));

    expect(failure.errors[0]).toMatchObject({ field: 'toLocationId', code: 'RANGE' });
    expect(order).not.toContain('transfer.create');
  });

  it('⛔ 코어가 전이를 skip 하면 409 INVALID_STATE — 응답이 조용히 거짓이 되지 않게 되돌린다', async () => {
    const { tx, deps } = build({ skipMove: true });

    expect((await caught<ConflictException>(() => postStockReinstatement(tx, deps, write()))).conflict.code).toBe('INVALID_STATE');
  });

  it('⛔ 원장 흡수·예측 어긋남은 조용히 넘기지 않고 던진다', async () => {
    const absorbed = build({ alreadyPosted: true });
    await expect(postStockReinstatement(absorbed.tx, absorbed.deps, write())).rejects.toThrow(/흡수/);

    // 전량으로 예측했는데 코어가 열린 보류가 남았다고 한다.
    const mismatch = build({ openAfter: 1 });
    await expect(postStockReinstatement(mismatch.tx, mismatch.deps, write())).rejects.toThrow(/어긋났다/);
  });
});
