/**
 * 재고 이동 조회 3건 + 반출 등록 + 도착 확정(I-13 PR ①②③) + 라인 치환 자물쇠·진행 판별자 축(PR ④).
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
/** 403 을 재려면 «권한 없는» 계정이 하나 더 있어야 한다 — 정리 루프도 함께 고친다(출고 선례). */
const NOPERM_ID = 'e2e-st-noperm';
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
  let noPermCookie: string[];

  let businessUnitId: number;
  let warehouse1Id: number;
  let warehouse2Id: number;
  let warehouse3Id: number;
  let location1Id: number;
  let location2Id: number;
  /** `warehouse2` 의 «실제» 도착 위치 — 계획과 다른 위치로 스캔했을 때. */
  let location3Id: number;
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

  // ── 도착 확정 (PR ③) ────────────────────────────────────────────────────────

  it('⭐ 전량 도착이 200 과 POSTED 를 내고 receivedAt 이 채워진다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));

    const response = await callArrive(transfer, arrival(transfer, 4)).expect(200);

    const body = response.body as DetailBody;
    expect(body.stockTransfer.statusCode).toBe('POSTED');
    expect(body.stockTransfer.receivedAt).toBe(AT);
    expect(body.lines[0].receivedQty).toBe(4);
    // ⛔ `version_no` 를 ETag 로 «안» 내린다 — 계약 200 에 응답 헤더 선언이 0건이다. 여기
    //    보이는 값은 express 가 본문에서 만든 약한 ETag 다(다음 쓰기는 상세 GET 로 받는다).
    expect(response.headers.etag).not.toMatch(/^\d+$/);
  });

  it('⭐ 원장 둘째 줄이 from={도착 창고, 계획 위치, IN_TRANSIT} / to={도착 창고, 실제 위치, 반출 전 재고 상태} 로 선다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    await callArrive(transfer, arrival(transfer, 4)).expect(200);

    const [line] = await prisma.inventory_transaction_line.findMany({
      where: { inventory_transaction: { transaction_no: `${transfer.stockTransfer.stockTransferNo}-A` } },
    });
    expect(line).toMatchObject({
      from_warehouse_id: BigInt(warehouse2Id),
      from_location_id: BigInt(location2Id),
      from_inventory_status_code: 'IN_TRANSIT',
      to_warehouse_id: BigInt(warehouse2Id),
      to_location_id: BigInt(location2Id),
      // ⭐ `AVAILABLE` 고정이 아니라 «반출 라인의 출발 상태»다(결정 — 통보 125).
      to_inventory_status_code: 'AVAILABLE',
      // 품질은 두 끝점이 같다 — 이동은 판정이 아니다.
      from_quality_status_code: 'NORMAL',
      to_quality_status_code: 'NORMAL',
    });
  });

  it('⭐ inventory_balance 세 지점 — 출발 위치 0 · IN_TRANSIT 0 · 도착 위치 수량', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    await callArrive(transfer, arrival(transfer, 4)).expect(200);

    expect(await onHand(lot, location1Id, 'AVAILABLE')).toBe(6);
    expect(await onHand(lot, location2Id, 'IN_TRANSIT')).toBe(0);
    expect(await onHand(lot, location2Id, 'AVAILABLE')).toBe(4);
  });

  it('⭐ 같은 품목·LOT 을 같은 위치로 두 번 이동해도 도착이 200 이다', async () => {
    // ⚠ 두 번째 도착의 `from` 키(7칸)에는 첫 도착이 세운 `AVAILABLE` 잔액이 함께 걸린다 —
    //    반출 원장이 준 11칸으로 고르지 않으면 여기가 언제나 400 이다(재수립 R-6).
    const lot = await seedBalance(10);
    const first = await created(draft(lot, 3));
    await callArrive(first, arrival(first, 3)).expect(200);
    const second = await created(draft(lot, 2));

    await callArrive(second, arrival(second, 2)).expect(200);

    expect(await onHand(lot, location2Id, 'AVAILABLE')).toBe(5);
    expect(await onHand(lot, location2Id, 'IN_TRANSIT')).toBe(0);
  });

  it('receipt_transaction_line_id 가 되짚고 transactionNo 가 ST-…-A 다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    await callArrive(transfer, arrival(transfer, 4)).expect(200);

    const no = transfer.stockTransfer.stockTransferNo;
    // 같은 영업일에 두 번 전기했는데 `uq_inventory_transaction_no` 를 안 깬다.
    const [issue] = await ledgerLinesOf(no);
    const [receipt] = await ledgerLinesOf(`${no}-A`);
    const line = await prisma.stock_transfer_line.findFirstOrThrow({
      where: { stock_transfer_id: transfer.stockTransfer.stockTransferId },
    });
    expect(line.issue_transaction_line_id).toBe(issue.inventory_transaction_line_id);
    expect(line.receipt_transaction_line_id).toBe(receipt.inventory_transaction_line_id);
  });

  it('toLocationId 재정의가 라인의 to_location_id 를 갱신하고 원장 to 가 그 위치다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));

    const response = await callArrive(transfer, arrival(transfer, 4, location3Id)).expect(200);

    expect((response.body as DetailBody).lines[0].toLocationId).toBe(location3Id);
    const [line] = await prisma.inventory_transaction_line.findMany({
      where: { inventory_transaction: { transaction_no: `${transfer.stockTransfer.stockTransferNo}-A` } },
    });
    // ⭐ `from` 은 반출 원장이 준 «계획» 위치 그대로다 — 두 값이 달라도 잔액이 안 어긋난다.
    expect(line.from_location_id).toBe(BigInt(location2Id));
    expect(line.to_location_id).toBe(BigInt(location3Id));
    expect(await onHand(lot, location3Id, 'AVAILABLE')).toBe(4);
  });

  it('⭐ 부분 도착은 상태를 안 옮긴다 — REGISTERED 그대로이고 잔량이 IN_TRANSIT 에 남는다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));

    const body = (await callArrive(transfer, arrival(transfer, 3)).expect(200)).body as DetailBody;

    expect(body.stockTransfer.statusCode).toBe('REGISTERED');
    expect(body.stockTransfer.receivedAt).toBe(AT);
    expect(await onHand(lot, location2Id, 'IN_TRANSIT')).toBe(1);
    // ⚠ 그 전표가 미완 목록에서 «사라진다» — `received_at` 이 찼고 `POSTED` 도 아니다
    //    (닫는 오퍼레이션이 계약에 0건 · 결정 — 통보 124).
    const pending = await list('inTransitOnly=true');
    expect(pending.items.map((row) => row.stockTransferId)).not.toContain(
      body.stockTransfer.stockTransferId,
    );
  });

  it('⭐ 둘째 :arrive 는 400 STATE_LOCKED 다 — 부분 도착 뒤에도 그렇다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    await callArrive(transfer, arrival(transfer, 2)).expect(200);

    const again = await callArrive(transfer, arrival(transfer, 2)).expect(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', field: 'stockTransferId' });
    // 원장도 잔액도 안 늘었다.
    expect(await onHand(lot, location2Id, 'AVAILABLE')).toBe(2);
  });

  it('receivedQty > shippedQty 는 400 RANGE · receivedQty=0 인 라인은 원장 라인을 안 만든다', async () => {
    const lot = await seedBalance(10);
    const over = await created(draft(lot, 4));
    const tooMany = await callArrive(over, arrival(over, 5)).expect(400);
    expect(tooMany.body.errors[0]).toMatchObject({ code: 'RANGE', field: 'lines[0].receivedQty' });

    const zero = await created(draft(await seedBalance(10), 4));
    const body = (await callArrive(zero, arrival(zero, 0)).expect(200)).body as DetailBody;
    expect(body.stockTransfer.statusCode).toBe('REGISTERED');
    expect(body.lines[0].receivedQty).toBe(0);
    expect(
      await prisma.inventory_transaction.count({
        where: { transaction_no: `${zero.stockTransfer.stockTransferNo}-A` },
      }),
    ).toBe(0);
  });

  it('남의 전표 라인·중복 라인·출발 위치로의 재정의는 400 INVALID 다', async () => {
    const transfer = await created(draft(await seedBalance(10), 4));
    const other = await created(draft(await seedBalance(10), 4));
    const lineId = transfer.lines[0].stockTransferLineId;

    const foreignLine = await callArrive(transfer, {
      businessDate: DAY,
      occurredAt: AT,
      lines: [{ stockTransferLineId: other.lines[0].stockTransferLineId, receivedQty: 1 }],
    }).expect(400);
    expect(foreignLine.body.errors[0]).toMatchObject({
      code: 'INVALID',
      field: 'lines[0].stockTransferLineId',
    });

    const duplicated = await callArrive(transfer, {
      businessDate: DAY,
      occurredAt: AT,
      lines: [
        { stockTransferLineId: lineId, receivedQty: 1 },
        { stockTransferLineId: lineId, receivedQty: 1 },
      ],
    }).expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      code: 'INVALID',
      field: 'lines[1].stockTransferLineId',
    });

    // ⚠ 라인 CHECK `ck_stock_transfer_locations` 를 앞질러 낸다 — 안 막으면 500 이 샌다.
    const sameAsFrom = await callArrive(transfer, arrival(transfer, 1, location1Id)).expect(400);
    expect(sameAsFrom.body.errors[0]).toMatchObject({
      code: 'INVALID',
      field: 'lines[0].toLocationId',
    });
    // 셋 다 거부됐으니 도착은 안 일어났다.
    expect(await onHand(transfer.lines[0].lotId, location2Id, 'IN_TRANSIT')).toBe(4);
  });

  it(':arrive 에 X-Worker-No 가 없으면 400 REQUIRED · 없는 사번이면 400 INVALID', async () => {
    const transfer = await created(draft(await seedBalance(10), 4));

    const missing = await callArrive(transfer, arrival(transfer, 4), { worker: null }).expect(400);
    expect(missing.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'X-Worker-No' });

    const unknown = await callArrive(transfer, arrival(transfer, 4), { worker: 'NO-SUCH' }).expect(400);
    expect(unknown.body.errors[0]).toMatchObject({ code: 'INVALID', field: 'X-Worker-No' });
  });

  it('If-Match 어긋남은 409 · 안 실으면 통과 · 같은 멱등키 재전송이 원장을 안 늘린다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));

    const stale = await callArrive(transfer, arrival(transfer, 4), { ifMatch: 9 }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });

    const key = randomUUID();
    await callArrive(transfer, arrival(transfer, 4), { key }).expect(200);
    await callArrive(transfer, arrival(transfer, 4), { key }).expect(200);
    expect(
      await prisma.inventory_transaction.count({
        where: { transaction_no: `${transfer.stockTransfer.stockTransferNo}-A` },
      }),
    ).toBe(1);
    expect(await onHand(lot, location2Id, 'AVAILABLE')).toBe(4);
  });

  // ── 도착 확정 · 다중 라인 (PR ③ 리뷰 Major-2) ────────────────────────────────
  // ⚠ 위 12건은 «전부 1라인»이라 라인 짝짓기·전량 판정이 통째로 무검증이었다. 아래 셋이
  //    그 자리를 덮는다 — 본문 순서 · 0 수량 · 본문에 안 실린 라인 · 오류 자리 번호.

  it('⭐ 다중 라인 — 본문을 역순으로 싣고 가운데를 0 수량으로 받아도 각 라인이 «자기» 원장 줄을 되짚는다', async () => {
    const lotA = await seedBalance(10);
    const lotB = await seedBalance(10);
    const lotC = await seedBalance(10);
    const transfer = await created({
      ...draft(lotA, 3),
      lines: [line(lotA, 3), line(lotB, 5), line(lotC, 7)],
    });
    const [l1, l2, l3] = transfer.lines;

    // ⭐ 본문 순서 ≠ 전표 라인 순서 · 가운데 라인은 0 수량이라 원장 라인이 «없다».
    const body = (
      await callArrive(
        transfer,
        arrivalOf([
          { line: l3, receivedQty: 7 },
          { line: l2, receivedQty: 0 },
          { line: l1, receivedQty: 3 },
        ]),
      ).expect(200)
    ).body as DetailBody;

    // 전량이 아니다(L2 가 0) — 상태를 안 옮긴다.
    expect(body.stockTransfer.statusCode).toBe('REGISTERED');
    expect(body.lines.map((row) => row.receivedQty)).toEqual([3, 0, 7]);

    // 원장은 «본문 순서»로 선다 — L3 가 line_no 1, L1 이 2 다(0 수량 라인은 빠진다).
    const ledger = await ledgerLinesOf(`${transfer.stockTransfer.stockTransferNo}-A`);
    expect(ledger.map((row) => row.lot_id)).toEqual([BigInt(lotC), BigInt(lotA)]);

    const rows = await prisma.stock_transfer_line.findMany({
      where: { stock_transfer_id: transfer.stockTransfer.stockTransferId },
      orderBy: { line_no: 'asc' },
      select: { receipt_transaction_line_id: true },
    });
    // ⭐ 짝짓기는 «전기한 횟수»로 돈다 — 본문 자리 번호로 짚으면 마지막 라인이 널이 된다.
    expect(rows.map((row) => row.receipt_transaction_line_id)).toEqual([
      ledger[1].inventory_transaction_line_id,
      null,
      ledger[0].inventory_transaction_line_id,
    ]);

    expect(await onHand(lotA, location2Id, 'AVAILABLE')).toBe(3);
    expect(await onHand(lotC, location2Id, 'AVAILABLE')).toBe(7);
    // 0 수량 라인의 몫은 운송중에 그대로 남는다.
    expect(await onHand(lotB, location2Id, 'IN_TRANSIT')).toBe(5);
    expect(await onHand(lotB, location2Id, 'AVAILABLE')).toBe(0);
  });

  it('⭐ 다중 라인 전량 판정 — 본문에 «안» 실린 라인은 0 으로 세고, 둘 다 채우면 POSTED 다', async () => {
    const lotA = await seedBalance(10);
    const lotB = await seedBalance(10);
    const partial = await created({
      ...draft(lotA, 3),
      lines: [line(lotA, 3), line(lotB, 5)],
    });

    // L1 을 본문에서 «뺀다» — 실린 L2 는 전량이지만 전표는 전량이 아니다.
    const left = (
      await callArrive(partial, arrivalOf([{ line: partial.lines[1], receivedQty: 5 }])).expect(200)
    ).body as DetailBody;
    expect(left.stockTransfer.statusCode).toBe('REGISTERED');
    expect(left.lines.map((row) => row.receivedQty)).toEqual([0, 5]);
    expect(await onHand(lotA, location2Id, 'IN_TRANSIT')).toBe(3);

    const lotC = await seedBalance(10);
    const lotD = await seedBalance(10);
    const whole = await created({
      ...draft(lotC, 3),
      lines: [line(lotC, 3), line(lotD, 5)],
    });
    const done = (
      await callArrive(
        whole,
        arrivalOf([
          { line: whole.lines[1], receivedQty: 5 },
          { line: whole.lines[0], receivedQty: 3 },
        ]),
      ).expect(200)
    ).body as DetailBody;
    expect(done.stockTransfer.statusCode).toBe('POSTED');
    expect(done.lines.map((row) => row.receivedQty)).toEqual([3, 5]);
    expect(await onHand(lotC, location2Id, 'AVAILABLE')).toBe(3);
    expect(await onHand(lotD, location2Id, 'AVAILABLE')).toBe(5);
  });

  it('⭐ 도착 하한 위반은 «본문» 자리 번호로 가리킨다 — 0 수량 라인을 걸러 배열 자리와 갈린다', async () => {
    const lotA = await seedBalance(10);
    const lotB = await seedBalance(10);
    const transfer = await created({
      ...draft(lotA, 3),
      lines: [line(lotA, 3), line(lotB, 5)],
    });

    // ⚠ 운송중 잔액을 «다른 이동»이 먼저 걷어 간다 — 반출이 세운 잔액이라 그러지 않고는
    //    도착의 하한 그물에 닿는 길이 없다(반출 원장 = 도착이 깎을 수량).
    await created({
      ...draft(lotB, 5),
      fromWarehouseId: warehouse2Id,
      toWarehouseId: warehouse3Id,
      lines: [{ ...line(lotB, 5), fromLocationId: location2Id, toLocationId: foreignLocationId }],
    });
    expect(await onHand(lotB, location2Id, 'IN_TRANSIT')).toBe(0);

    const denied = await callArrive(
      transfer,
      arrivalOf([
        { line: transfer.lines[0], receivedQty: 0 },
        { line: transfer.lines[1], receivedQty: 5 },
      ]),
    ).expect(400);
    // ⭐ 전기 배열의 자리(0)가 아니라 «본문»의 자리(1)다.
    expect(denied.body.errors).toHaveLength(1);
    expect(denied.body.errors[0]).toMatchObject({
      code: 'NEGATIVE_BALANCE',
      field: 'lines[1].receivedQty',
    });

    // 거부됐으니 상태도 원장도 안 움직였다.
    const header = await prisma.stock_transfer.findUniqueOrThrow({
      where: { stock_transfer_id: transfer.stockTransfer.stockTransferId },
    });
    expect(header.status_code).toBe('REGISTERED');
    expect(header.received_at).toBeNull();
    expect(await onHand(lotA, location2Id, 'IN_TRANSIT')).toBe(3);
    expect(
      await prisma.inventory_transaction.count({
        where: { transaction_no: `${transfer.stockTransfer.stockTransferNo}-A` },
      }),
    ).toBe(0);
  });

  // ── 라인 치환 자물쇠 `PUT …/lines` (PR ④) ───────────────────────────────────
  // ⚠ 200 은 «도달 불가»다 — `POST` 가 생성·반출을 한 번에 해 실재하는 모든 전표가
  //    `shipped_at IS NOT NULL` 이다. 아래는 그 사실 위에서 400·409·404·403·500 을 잰다.

  it('⭐ 반출이 끝난 전표의 라인 치환은 400 STATE_LOCKED 다 — 같은 멱등키로 다시 보내도 400 이다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    const id = transfer.stockTransfer.stockTransferId;
    const key = randomUUID();

    const denied = await callReplaceLines(id, { key }).expect(400);
    expect(denied.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', field: 'items' });

    // ⭐ 실패는 멱등 기록에 «안» 남는다 — 기록 INSERT 가 work() 와 같은 트랜잭션이라 함께
    //    롤백된다. 흡수된 200 이 아니라 같은 400 이 다시 나온다.
    const again = await callReplaceLines(id, { key }).expect(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('⭐⭐ shipped_at 이 널인 전표(손으로 심은 srA)는 500 으로 터진다 — 화면도 오퍼레이션도 만들 수 없는 상태다', async () => {
    // ⛔ 이 갈래를 400 으로 «합치면» 「shipped_at 을 아예 안 읽고 무조건 400」 구현과 모든
    //    테스트가 같아져 자물쇠가 조용히 사라져도 아무도 모른다. 이 한 줄이 유일한 그물이다.
    const burst = await callReplaceLines(srA).expect(500);
    // 던진 문장은 응답에 안 실린다(로그뿐) — 화면이 보는 것은 봉투 하나다.
    expect(burst.body.errors[0]).toMatchObject({ scope: 'screen', code: 'INTERNAL_ERROR' });
  });

  it('⭐ If-Match 가 어긋나면 409 이고 400 STATE_LOCKED «보다 먼저»다 — 그리고 재조회 뒤 같은 호출은 400 이다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    const id = transfer.stockTransfer.stockTransferId;

    const stale = await callReplaceLines(id, { ifMatch: '9' }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });

    // ⭐ 409 의 「다시 읽어 오면 풀린다」가 이 오퍼레이션에서는 «거짓»이다 — 바른 토큰으로
    //    다시 불러도 3단계가 400 이다(G-1 예외 자리 · 문의 162 ⓓ).
    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.headers.etag).toBe('1');

    const locked = await callReplaceLines(id, { ifMatch: String(detail.headers.etag) }).expect(400);
    expect(locked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('If-Match 를 안 실으면 400 REQUIRED · "abc" 면 400 INVALID — 가드가 핸들러 앞에서 낸다', async () => {
    // ⚠ 대상이 srA(반출 전)라 가드를 지나면 500 이 나온다 — 400 이 「핸들러 앞」의 증거다.
    const missing = await callReplaceLines(srA, { ifMatch: null }).expect(400);
    expect(missing.body.errors[0]).toMatchObject({ code: 'REQUIRED' });

    const invalid = await callReplaceLines(srA, { ifMatch: 'abc' }).expect(400);
    expect(invalid.body.errors[0]).toMatchObject({ code: 'INVALID' });
  });

  it('없는 전표의 라인 치환은 404 다', async () => {
    // ⚠ 계약이 404 를 «선언하지 않는다»(형제 6건 전원의 관행). 유효한 If-Match 를 손으로
    //    실어야 0-e 가드를 지나 1단계에 닿는다.
    await callReplaceLines(999999999, { ifMatch: '1' }).expect(404);
  });

  it('⭐ 치환이 거부돼도 라인 배열·version_no·원장 건수가 하나도 안 바뀐다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    const id = transfer.stockTransfer.stockTransferId;
    const before = await linesOf(id);
    const ledgerBefore = await ledgerCount(id);

    const denied = await callReplaceLines(id).expect(400);
    // ⛔ 계약 200 에 응답 헤더 선언이 0건이다 — `setEtag` 를 부르면 이 줄이 빨개진다.
    // ⚠ `toBeUndefined()` 로는 못 잰다: express 가 본문에 «약한 검증자»(`W/"…"`)를 스스로
    //    단다. 갈라야 하는 것은 `setEtag` 가 싣는 **버전 토큰**(맨 숫자)이다.
    expect(denied.headers.etag).not.toMatch(/^"?\d+"?$/);

    expect(await linesOf(id)).toEqual(before);
    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    // version_no 를 «안» 올린다 — 바뀐 행이 0이라 올릴 근거가 없다.
    expect(detail.headers.etag).toBe('1');
    expect(await ledgerCount(id)).toBe(ledgerBefore);
  });

  // ── 문서진행 판별자 축 (PR ④ · 통보 059) ─────────────────────────────────────

  it('⭐⭐ document-progress STOCK_TRANSFER 상세가 같은 id 의 «PT-» 원장을 안 집는다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    const id = transfer.stockTransfer.stockTransferId;

    // 적치가 «같은 판별자»로 쌓는 행을 흉내낸다(`putaway-posting.ts:18,53` — 원장은 불변이라
    // 적치 코드를 못 고친다). ⭐ occurred_at 을 AT 보다 «이르게» 둔다 — `occurred_at asc` 가
    // 이쪽을 먼저 집어야 판별 축을 지웠을 때 실제로 빨개진다(동률이면 반증이 안 선다).
    await prisma.inventory_transaction.create({
      data: {
        business_date: new Date('2026-05-11'),
        transaction_no: 'PT-20260511-9999',
        transaction_type_code: 'STOCK_TRANSFER',
        plant_id: plantId,
        occurred_at: new Date('2026-05-11T09:00:00.000Z'),
        source_document_type_code: 'STOCK_TRANSFER',
        source_document_id: id,
        status_code: 'POSTED',
        idempotency_key: `PUTAWAY_TASK:PT-20260511-9999`,
      },
    });

    expect(await postedStep(id)).toMatchObject({
      inventoryTransactionNo: transfer.stockTransfer.stockTransferNo,
      businessDate: DAY,
    });
  });

  it('⭐ 진행 조회의 POSTED 줄은 «반출» 원장(ST-…)이다 — 도착 뒤에도 첫 원장을 집는다', async () => {
    const lot = await seedBalance(10);
    const transfer = await created(draft(lot, 4));
    const id = transfer.stockTransfer.stockTransferId;
    // ⚠ 도착 원장을 «늦은» 시각으로 세운다 — 반출과 동률이면 asc/desc 가 갈리지 않는다.
    await callArrive(transfer, {
      ...arrival(transfer, 4),
      occurredAt: '2026-05-12T18:00:00.000Z',
    }).expect(200);

    expect(await postedStep(id)).toMatchObject({
      inventoryTransactionNo: transfer.stockTransfer.stockTransferNo,
    });
  });

  it('PUT …/lines — 권한 없는 사용자는 403(manual-permissions 등록 확인)', async () => {
    // 미등록이면 `PermissionGuard` 가 던져 500 이다 — 403 이 나온다는 것이 등록의 증거다.
    await callReplaceLines(srA, { cookies: noPermCookie }).expect(403);
  });

  // ── 라인 치환 헬퍼 ───────────────────────────────────────────────────────────

  /** ⚠ 본문은 required 6 을 채운 한 줄이다 — 안 채우면 계약 검증 가드가 자물쇠 «앞»에서 400 이다. */
  function callReplaceLines(
    stockTransferId: number,
    opts: { key?: string; ifMatch?: string | null; cookies?: string[] } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .put(`/api/logistics/stock-transfers/${stockTransferId}/lines`)
      .set('Cookie', opts.cookies ?? cookie)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.ifMatch !== null) call.set('If-Match', opts.ifMatch ?? '1');
    return call.send({ items: [line(lotId, 1)] });
  }

  async function linesOf(stockTransferId: number): Promise<LineBody[]> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers/${stockTransferId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    return (response.body as { items: LineBody[] }).items;
  }

  function ledgerCount(stockTransferId: number): Promise<number> {
    return prisma.inventory_transaction.count({
      where: { source_document_type_code: 'STOCK_TRANSFER', source_document_id: stockTransferId },
    });
  }

  /** 진행 상세의 `POSTED` 줄 — 없으면 `undefined` 라 단언이 그대로 빨개진다. */
  async function postedStep(
    stockTransferId: number,
  ): Promise<{ inventoryTransactionNo?: string; businessDate?: string } | undefined> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress/STOCK_TRANSFER/${stockTransferId}`)
      .set('Cookie', cookie)
      .expect(200);
    const body = response.body as {
      steps: { stepCode: string; inventoryTransactionNo?: string; businessDate?: string }[];
    };
    return body.steps.find((step) => step.stepCode === 'POSTED');
  }

  // ── 도착 헬퍼 ────────────────────────────────────────────────────────────────

  function callArrive(
    transfer: DetailBody,
    body: Record<string, unknown>,
    opts: { key?: string; worker?: string | null; ifMatch?: number } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .post(`/api/logistics/stock-transfers/${transfer.stockTransfer.stockTransferId}:arrive`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.worker !== null) call.set('X-Worker-No', opts.worker ?? WORKER_NO);
    if (opts.ifMatch !== undefined) call.set('If-Match', String(opts.ifMatch));
    return call.send(body);
  }

  function arrival(
    transfer: DetailBody,
    receivedQty: number,
    toLocationId?: number,
  ): Record<string, unknown> {
    return arrivalOf([{ line: transfer.lines[0], receivedQty, toLocationId }]);
  }

  /**
   * ⭐ 다중 라인 도착 본문. `arrival()` 은 언제나 첫 라인 하나라 «본문 순서»도 「본문에 안
   * 실린 라인」도 시험할 수 없다 — 그 자리를 여는 헬퍼다(리뷰 Major-2).
   */
  function arrivalOf(
    items: { line: LineBody; receivedQty: number; toLocationId?: number }[],
  ): Record<string, unknown> {
    return {
      businessDate: DAY,
      occurredAt: AT,
      lines: items.map(({ line: row, receivedQty, toLocationId }) => ({
        stockTransferLineId: row.stockTransferLineId,
        receivedQty,
        ...(toLocationId === undefined ? {} : { toLocationId }),
      })),
    };
  }

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
      line_no: number;
      lot_id: bigint | null;
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
    const location3 = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC5`,
        location_name: '이동검사실제도착위치',
        location_type_code: 'BIN',
      },
    });
    location3Id = Number(location3.location_id);
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

    // ⭐ 권한 «없는» 둘째 계정 — 역할을 안 준다. 아래 cleanup 의 정리 루프를 «같이» 고쳐야
    //    두 번째 실행에서 `login_id @unique` 로 P2002 가 나 스위트 전체가 죽지 않는다.
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '이동권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    noPermCookie = await login(NOPERM_ID);
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

    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    await prisma.role_permission.deleteMany({ where: { role: { role_code: ROLE } } });
    await prisma.role.deleteMany({ where: { role_code: ROLE } });
  }
});
