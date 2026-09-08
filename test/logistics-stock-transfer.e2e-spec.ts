/**
 * 재고 이동 조회 3건 + 반출 등록(I-13 PR ①②). 도착·라인 치환·판별자 축은 PR ③④ 몫이다.
 *
 * ⚠ 조회용 전표는 prisma 로 직접 심고, **반출 등록은 오퍼레이션으로** 부른다 — 잔액은
 * `POST /logistics/goods-receipts` 가 세운다(직접 INSERT 하면 트리거와 차원 11칸을 손으로
 * 맞춰야 하고, 입고가 세운 차원이 곧 반출이 되읽을 차원이다).
 * ⭐ 원장을 만드는 스위트라 정리는 `TRUNCATE` 다 — `block_ledger_*_mutation` 이 행 삭제를
 * 막아 다른 길이 없다(적치·입고 스위트 선례).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-st-probe';
const PASSWORD = 'ST-검사-비밀번호';
const PREFIX = 'STE2E';
const ROLE = 'E2E_ST';
// `W-01-10` 은 잔액을 세우는 입고 등록용이다(이 스위트의 픽스처가 그 오퍼레이션을 부른다).
const PERMISSIONS = ['M-01-10', 'W-01-10'];
const DAY = '2026-05-12';
const AT = '2026-05-12T10:00:00.000Z';
const WORKER_NO = 'STE2E01';

interface StockTransferBody {
  stockTransferId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  transferTypeCode: string;
  statusCode: string;
  requestedAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
}
interface LineBody {
  stockTransferLineId: number;
  lineNo: number;
  itemId: number;
  lotId: number;
  requestedQty: number;
  shippedQty: number;
  receivedQty: number;
  fromLocationId: number;
  toLocationId: number;
  handlingUnitId: number | null;
}
interface DetailBody {
  stockTransfer: StockTransferBody & { stockTransferNo: string };
  lines: LineBody[];
}

describe('재고 이동 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let businessUnitId: number;
  let warehouse1Id: number;
  let warehouse2Id: number;
  let warehouse3Id: number;
  let location1Id: number;
  let location2Id: number;
  let uomId: number;
  let itemId: number;
  let lotId: number;
  let plantId: number;
  /** 다른 창고(`warehouse3`)의 위치 — 그물 「짝 창고 소속」을 증명한다. */
  let foreignLocationId: number;
  /** `warehouse2` 의 비활성 위치. */
  let inactiveLocationId: number;
  let handlingUnitId: number;

  let srA: number;
  let srB: number;
  let srC: number;
  let srD: number;
  let srE: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    await makeStockTransfers();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 fromWarehouseId·toWarehouseId 로 걸러진다', async () => {
    const byFrom = await list(`fromWarehouseId=${warehouse1Id}`);
    expect(byFrom.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srD].sort(),
    );

    const byTo = await list(`toWarehouseId=${warehouse2Id}`);
    expect(byTo.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srD, srE].sort(),
    );
  });

  it('목록이 transferTypeCode·statusCode 로 걸러진다', async () => {
    const byType = await list('transferTypeCode=DEFECT_RETURN');
    expect(byType.items.map((row) => row.stockTransferId)).toEqual([srB]);

    const byStatus = await list('statusCode=REGISTERED');
    expect(byStatus.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srE].sort(),
    );
  });

  it('⭐ inTransitOnly=true 는 반출됐고 도착 안 한 건만 낸다', async () => {
    // srB·srD 는 도착까지 끝났고(도착 완료), srA·srE 는 반출 전이다 — 도착 완료 건이
    // 안 나오는 것으로 「반출됐으나 도착 안 함」 축을 증명한다.
    const { items } = await list('inTransitOnly=true');
    expect(items.map((row) => row.stockTransferId)).toEqual([srC]);
  });

  it('requestedAtFrom·requestedAtTo 가 UTC 하루 경계로 자른다', async () => {
    const { items } = await list('requestedAtFrom=2026-05-11&requestedAtTo=2026-05-12');
    expect(items.map((row) => row.stockTransferId).sort()).toEqual([srB, srC].sort());
  });

  it('statusCode=POSTED × inTransitOnly=true 는 빈 목록이고 400 이 아니다', async () => {
    const { items } = await list('statusCode=POSTED&inTransitOnly=true');
    expect(items).toEqual([]);
  });

  it('목록이 requested_at desc · PK desc 로 온다', async () => {
    const { items } = await list(`toWarehouseId=${warehouse2Id}`);
    expect(items.map((row) => row.stockTransferId)).toEqual([srE, srD, srC, srA]);
  });

  it('상세가 ETag 로 version_no 를 내리고 lines 를 함께 싣는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers/${srA}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toBe('1');
    const body = response.body as DetailBody;
    expect(body.stockTransfer.stockTransferId).toBe(srA);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].itemId).toBe(itemId);
    expect(body.lines[0].lotId).toBe(lotId);
  });

  it('없는 전표의 상세·라인 목록은 둘 다 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/stock-transfers/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/logistics/stock-transfers/999999999/lines')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 반출 등록 `POST /logistics/stock-transfers` (PR ②) ───────────────────────
  // ⚠ 여기부터의 픽스처는 오퍼레이션으로 만든다 — 목록 단언은 위에서 이미 끝났다.

  it('⭐ 반출 등록이 201 과 StockTransferDetailResponse 를 내고 ETag 가 "1" 이다', async () => {
    const lot = await seedBalance(10);
    const response = await callCreate(draft(lot, 4)).expect(201);

    expect(response.headers.etag).toBe('1');
    const body = response.body as DetailBody;
    expect(body.stockTransfer.fromWarehouseId).toBe(warehouse1Id);
    expect(body.stockTransfer.toWarehouseId).toBe(warehouse2Id);
    expect(body.lines).toHaveLength(1);
  });

  it('stockTransferNo 가 ST-{YYYYMMDD}-{SEQ4} 이고 businessDate 를 기간 키로 쓴다', async () => {
    const lot = await seedBalance(10);
    const body = await created(draft(lot, 1));
    expect(body.stockTransfer.stockTransferNo).toMatch(/^ST-20260512-\d{4}$/);
  });

  it('statusCode 가 REGISTERED · shippedAt 이 occurredAt · receivedAt 이 null 이다', async () => {
    const lot = await seedBalance(10);
    const body = await created(draft(lot, 1));
    expect(body.stockTransfer.statusCode).toBe('REGISTERED');
    expect(body.stockTransfer.shippedAt).toBe(AT);
    expect(body.stockTransfer.receivedAt).toBeNull();
  });

  it('requestedAt 을 안 보내면 occurredAt 이 들어간다', async () => {
    const lot = await seedBalance(10);
    const body = await created(draft(lot, 1));
    expect(body.stockTransfer.requestedAt).toBe(AT);

    const lot2 = await seedBalance(10);
    const withRequested = await created({
      ...draft(lot2, 1),
      requestedAt: '2026-05-11T08:00:00.000Z',
    });
    expect(withRequested.stockTransfer.requestedAt).toBe('2026-05-11T08:00:00.000Z');
  });

  it('라인의 lineNo 가 요청 순서로 1..N 이고 shippedQty=requestedQty · receivedQty=0 이다', async () => {
    const lotA = await seedBalance(10);
    const lotB = await seedBalance(10);
    const body = await created({
      ...draft(lotA, 3),
      lines: [line(lotA, 3), line(lotB, 5)],
    });
    expect(body.lines.map((row) => row.lineNo)).toEqual([1, 2]);
    expect(body.lines.map((row) => row.lotId)).toEqual([lotA, lotB]);
    expect(body.lines.map((row) => row.shippedQty)).toEqual([3, 5]);
    expect(body.lines.map((row) => row.receivedQty)).toEqual([0, 0]);
  });

  it('⭐ 원장 한 줄이 from=출발 위치 / to={도착 창고, 계획 도착 위치, IN_TRANSIT} 로 선다', async () => {
    const lot = await seedBalance(10);
    // ⭐ A4 로 선 `handling_unit_id` 가 문서 라인 → 원장 라인까지 «관통»하는지 본다.
    const body = await created({ ...draft(lot, 4), lines: [{ ...line(lot, 4), handlingUnitId }] });
    expect(body.lines[0].handlingUnitId).toBe(handlingUnitId);

    const ledger = await ledgerLinesOf(body.stockTransfer.stockTransferNo);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      from_warehouse_id: BigInt(warehouse1Id),
      from_location_id: BigInt(location1Id),
      from_inventory_status_code: 'AVAILABLE',
      to_warehouse_id: BigInt(warehouse2Id),
      to_location_id: BigInt(location2Id),
      to_inventory_status_code: 'IN_TRANSIT',
      ownership_type_code: 'OWNED',
      handling_unit_id: BigInt(handlingUnitId),
    });
    // 품질 상태는 서버가 고르지 않는다 — 잠근 잔액 행에서 되읽어 그대로 옮긴다.
    expect(ledger[0].to_quality_status_code).toBe(ledger[0].from_quality_status_code);
  });

  it('⭐ inventory_balance 가 출발 위치 0 · {도착 창고·계획 위치·IN_TRANSIT} 에 수량으로 옮겨진다', async () => {
    const lot = await seedBalance(10);
    await created(draft(lot, 4));

    expect(await onHand(lot, location1Id, 'AVAILABLE')).toBe(6);
    expect(await onHand(lot, location2Id, 'IN_TRANSIT')).toBe(4);
  });

  it('stock_transfer_line.issue_transaction_line_id 가 그 라인을 되짚는다', async () => {
    const lot = await seedBalance(10);
    const body = await created(draft(lot, 4));

    const row = await prisma.stock_transfer_line.findUniqueOrThrow({
      where: { stock_transfer_line_id: body.lines[0].stockTransferLineId },
      select: { issue_transaction_line_id: true, receipt_transaction_line_id: true },
    });
    const ledger = await ledgerLinesOf(body.stockTransfer.stockTransferNo);
    expect(row.issue_transaction_line_id).toBe(ledger[0].inventory_transaction_line_id);
    // 도착은 아직 없다(PR ③).
    expect(row.receipt_transaction_line_id).toBeNull();
  });

  it('⚠ 원장 헤더가 sourceDocumentTypeCode=STOCK_TRANSFER · sourceDocumentId=stockTransferId · transactionNo=ST-… 다', async () => {
    const lot = await seedBalance(10);
    const body = await created(draft(lot, 4));

    const header = await prisma.inventory_transaction.findFirstOrThrow({
      where: { transaction_no: body.stockTransfer.stockTransferNo },
    });
    expect(header.source_document_type_code).toBe('STOCK_TRANSFER');
    expect(Number(header.source_document_id)).toBe(body.stockTransfer.stockTransferId);
    expect(header.transaction_type_code).toBe('STOCK_TRANSFER');
    expect(header.status_code).toBe('POSTED');
  });

  it('⭐ fromWarehouseId === toWarehouseId 는 400 INVALID(toWarehouseId)', async () => {
    const lot = await seedBalance(10);
    // ⚠ 물리 CHECK `ck_stock_transfer_warehouses` 는 이미 DROP 됐다 — 서버가 유일한 그물이다.
    const response = await callCreate({
      ...draft(lot, 1),
      toWarehouseId: warehouse1Id,
      lines: [{ ...line(lot, 1), toLocationId: location1Id }],
    }).expect(400);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID', field: 'toWarehouseId' }),
    );
  });

  it('잔액이 모자라면 400 NEGATIVE_BALANCE · 그 위치에 그 LOT 이 없어도 같다', async () => {
    const lot = await seedBalance(2);
    const over = await callCreate(draft(lot, 5)).expect(400);
    expect(over.body.errors[0].code).toBe('NEGATIVE_BALANCE');

    const emptyLot = await makeLot();
    const none = await callCreate(draft(emptyLot, 1)).expect(400);
    expect(none.body.errors[0].code).toBe('NEGATIVE_BALANCE');
  });

  it('라인 0건은 400 LINE_REQUIRED · 그룹 밖 transferTypeCode 는 400 INVALID · fromLocationId===toLocationId 는 400 INVALID', async () => {
    const lot = await seedBalance(10);

    const empty = await callCreate({ ...draft(lot, 1), lines: [] }).expect(400);
    expect(empty.body.errors[0].code).toBe('LINE_REQUIRED');

    const badType = await callCreate({ ...draft(lot, 1), transferTypeCode: 'NOPE' }).expect(400);
    expect(badType.body.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID', field: 'transferTypeCode' }),
    );

    const sameLocation = await callCreate({
      ...draft(lot, 1),
      lines: [{ ...line(lot, 1), toLocationId: location1Id }],
    }).expect(400);
    expect(sameLocation.body.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID', field: 'lines[0].toLocationId' }),
    );
  });

  it('다른 창고의 위치·비활성 위치는 400 INVALID', async () => {
    const lot = await seedBalance(10);

    const foreign = await callCreate({
      ...draft(lot, 1),
      lines: [{ ...line(lot, 1), toLocationId: foreignLocationId }],
    }).expect(400);
    expect(foreign.body.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID', field: 'lines[0].toLocationId' }),
    );

    const inactive = await callCreate({
      ...draft(lot, 1),
      lines: [{ ...line(lot, 1), toLocationId: inactiveLocationId }],
    }).expect(400);
    expect(inactive.body.errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID', field: 'lines[0].toLocationId' }),
    );
  });

  it('X-Worker-No 가 없으면 400 REQUIRED · 없는 사번이면 400 INVALID', async () => {
    const lot = await seedBalance(10);

    const missing = await callCreate(draft(lot, 1), { worker: null }).expect(400);
    expect(missing.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'X-Worker-No' });

    const unknown = await callCreate(draft(lot, 1), { worker: 'NO-SUCH' }).expect(400);
    expect(unknown.body.errors[0]).toMatchObject({ code: 'INVALID', field: 'X-Worker-No' });
  });

  it('같은 Idempotency-Key 재전송이 같은 응답을 내고 전표·원장이 1건 그대로다', async () => {
    const lot = await seedBalance(10);
    const key = randomUUID();
    const first = await callCreate(draft(lot, 4), { key }).expect(201);
    const again = await callCreate(draft(lot, 4), { key }).expect(201);

    const body = first.body as DetailBody;
    expect((again.body as DetailBody).stockTransfer.stockTransferId).toBe(
      body.stockTransfer.stockTransferId,
    );
    expect(
      await prisma.inventory_transaction.count({
        where: { transaction_no: body.stockTransfer.stockTransferNo },
      }),
    ).toBe(1);
    expect(await onHand(lot, location2Id, 'IN_TRANSIT')).toBe(4);
  });

  it('If-Match 를 실어도 안 실어도 통과한다', async () => {
    const lot = await seedBalance(10);
    // 오프라인 큐는 낙관적 잠금 토큰을 싣지 않는다(C-9) — 실려도 새 자원이라 대조할 것이 없다.
    await callCreate(draft(lot, 1), { ifMatch: 1 }).expect(201);
  });

  // ── 반출 등록 헬퍼 ───────────────────────────────────────────────────────────

  function callCreate(
    body: Record<string, unknown>,
    opts: { key?: string; worker?: string | null; ifMatch?: number } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .post('/api/logistics/stock-transfers')
      .set('Cookie', cookie)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.worker !== null) call.set('X-Worker-No', opts.worker ?? WORKER_NO);
    if (opts.ifMatch !== undefined) call.set('If-Match', String(opts.ifMatch));
    return call.send(body);
  }

  async function created(body: Record<string, unknown>): Promise<DetailBody> {
    const response = await callCreate(body).expect(201);
    return response.body as DetailBody;
  }

  function line(forLotId: number, qty: number): Record<string, unknown> {
    return {
      itemId,
      lotId: forLotId,
      requestedQty: qty,
      uomId,
      fromLocationId: location1Id,
      toLocationId: location2Id,
    };
  }

  function draft(forLotId: number, qty: number): Record<string, unknown> {
    return {
      transferTypeCode: 'NORMAL',
      fromBusinessUnitId: businessUnitId,
      toBusinessUnitId: businessUnitId,
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      businessDate: DAY,
      occurredAt: AT,
      lines: [line(forLotId, qty)],
    };
  }

  /** 잔액은 입고 오퍼레이션이 세운다 — 입고가 세운 차원이 곧 반출이 되읽을 차원이다. */
  async function seedBalance(qty: number): Promise<number> {
    const forLotId = await makeLot();
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId: warehouse1Id,
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId,
            lotId: forLotId,
            receiptQty: qty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: location1Id,
          },
        ],
      })
      .expect(201);
    return forLotId;
  }

  async function makeLot(): Promise<number> {
    const row = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${randomUUID().slice(0, 8)}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    return Number(row.lot_id);
  }

  function ledgerLinesOf(
    transactionNo: string,
  ): Promise<
    {
      inventory_transaction_line_id: bigint;
      from_quality_status_code: string | null;
      to_quality_status_code: string | null;
    }[]
  > {
    return prisma.inventory_transaction_line.findMany({
      where: { inventory_transaction: { transaction_no: transactionNo } },
      orderBy: { line_no: 'asc' },
    });
  }

  async function onHand(
    forLotId: number,
    locationId: number,
    inventoryStatusCode: string,
  ): Promise<number> {
    const row = await prisma.inventory_balance.findFirst({
      where: {
        lot_id: forLotId,
        location_id: locationId,
        inventory_status_code: inventoryStatusCode,
      },
      select: { on_hand_qty: true },
    });
    return row === null ? 0 : Number(row.on_hand_qty);
  }

  async function list(query: string): Promise<{ items: StockTransferBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as { items: StockTransferBody[] };
  }

  async function makeStockTransfers(): Promise<void> {
    srA = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-10T09:00:00.000Z',
      withLine: true,
    });
    srB = await makeTransfer({
      fromWarehouseId: warehouse2Id,
      toWarehouseId: warehouse1Id,
      transferTypeCode: 'DEFECT_RETURN',
      statusCode: 'POSTED',
      requestedAt: '2026-05-11T09:00:00.000Z',
      shippedAt: '2026-05-11T10:00:00.000Z',
      receivedAt: '2026-05-11T11:00:00.000Z',
    });
    srC = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-12T09:00:00.000Z',
      shippedAt: '2026-05-12T10:00:00.000Z',
    });
    srD = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'POSTED',
      requestedAt: '2026-05-13T09:00:00.000Z',
      shippedAt: '2026-05-13T10:00:00.000Z',
      receivedAt: '2026-05-13T11:00:00.000Z',
    });
    srE = await makeTransfer({
      fromWarehouseId: warehouse3Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-14T09:00:00.000Z',
    });
  }

  async function makeTransfer(spec: {
    fromWarehouseId: number;
    toWarehouseId: number;
    transferTypeCode: string;
    statusCode: string;
    requestedAt: string;
    shippedAt?: string;
    receivedAt?: string;
    withLine?: boolean;
  }): Promise<number> {
    const row = await prisma.stock_transfer.create({
      data: {
        stock_transfer_no: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        transfer_type_code: spec.transferTypeCode,
        from_business_unit_id: businessUnitId,
        to_business_unit_id: businessUnitId,
        from_warehouse_id: spec.fromWarehouseId,
        to_warehouse_id: spec.toWarehouseId,
        requested_at: new Date(spec.requestedAt),
        shipped_at: spec.shippedAt ? new Date(spec.shippedAt) : null,
        received_at: spec.receivedAt ? new Date(spec.receivedAt) : null,
        status_code: spec.statusCode,
      },
    });
    if (spec.withLine) {
      await prisma.stock_transfer_line.create({
        data: {
          stock_transfer_id: row.stock_transfer_id,
          line_no: 1,
          item_id: itemId,
          lot_id: lotId,
          requested_qty: 10,
          uom_id: uomId,
          from_location_id: location1Id,
          to_location_id: location2Id,
        },
      });
    }
    return Number(row.stock_transfer_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '이동검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '이동검사사업부',
      },
    });
    businessUnitId = Number(unit.business_unit_id);
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '이동검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    const warehouse1 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH1`,
        warehouse_name: '이동검사출발창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse1Id = Number(warehouse1.warehouse_id);
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '이동검사도착창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse2Id = Number(warehouse2.warehouse_id);
    const warehouse3 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH3`,
        warehouse_name: '이동검사다른창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse3Id = Number(warehouse3.warehouse_id);

    const location1 = await prisma.location.create({
      data: {
        warehouse_id: warehouse1.warehouse_id,
        location_code: `${PREFIX}-LOC1`,
        location_name: '이동검사출발위치',
        location_type_code: 'BIN',
      },
    });
    location1Id = Number(location1.location_id);
    const location2 = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '이동검사도착위치',
        location_type_code: 'BIN',
      },
    });
    location2Id = Number(location2.location_id);
    const foreign = await prisma.location.create({
      data: {
        warehouse_id: warehouse3.warehouse_id,
        location_code: `${PREFIX}-LOC3`,
        location_name: '이동검사다른창고위치',
        location_type_code: 'BIN',
      },
    });
    foreignLocationId = Number(foreign.location_id);
    const inactive = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC4`,
        location_name: '이동검사비활성위치',
        location_type_code: 'BIN',
        is_active: false,
      },
    });
    inactiveLocationId = Number(inactive.location_id);

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '이동검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-1`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lotId = Number(lot.lot_id);

    await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
        worker_name: '이동검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    const handlingUnit = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-HU1`,
        handling_unit_type_code: 'PALLET',
        warehouse_id: warehouse1.warehouse_id,
        location_id: location1.location_id,
        status_code: 'ACTIVE',
      },
    });
    handlingUnitId = Number(handlingUnit.handling_unit_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '이동검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '이동검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    cookie = await login(LOGIN_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /**
   * ⛔ 원장은 트리거가 행 삭제를 막아 `TRUNCATE` 뿐이다(적치·입고 스위트와 같은 이유) —
   * CASCADE 가 `stock_transfer_line`·`putaway_task`·`goods_receipt_line` 까지 함께 비운다.
   * ⛔ `app.numbering_counter`/`numbering_rule` 은 전역 자원이라 안 지운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    // ⚠ 번호로 짚지 못한다 — 오퍼레이션이 만든 전표는 `ST-` 채번을 받는다. 창고로 짚는다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.stock_transfer_line
       WHERE stock_transfer_id IN (
             SELECT stock_transfer_id FROM logistics.stock_transfer
              WHERE from_warehouse_id IN
                    (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.stock_transfer
       WHERE from_warehouse_id IN
             (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')
          OR to_warehouse_id IN
             (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    await prisma.role_permission.deleteMany({ where: { role: { role_code: ROLE } } });
    await prisma.role.deleteMany({ where: { role_code: ROLE } });
  }
});
