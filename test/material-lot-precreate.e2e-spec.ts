/**
 * 피처 014 S3 — 자재 관리 LOT 을 P/O 몫만큼 조회 때 만든다(omf-all-around#349 · T009·T010·T020·T029·T043).
 * POP(P-01-01)은 단말 토큰(작업자 없음 — 조회다), 웹(W-01-14)은 세션 계정으로 부른다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { PrismaService } from '../src/prisma/prisma.service';
import { closeInboundLotFixture, receiveScan, terminalAuth, type InboundLotFixture } from './support/inbound-lot-fixture';

const PREFIX = 'E14PC';
const TZ = 'Asia/Ho_Chi_Minh';
const WORKER_NO = `${PREFIX}-W1`;
const LOTS = '/api/logistics/material-lots';
const PAIRS = '/api/logistics/material-lot-pairs';
const SUPPLIERS = '/api/logistics/material-lot-suppliers';
const LOOKUP = '/api/logistics/material-lots/lookup';
const BATCHES = '/api/logistics/material-lot-batches';
const ISSUES = '/api/app/document-issues';
const VOID = '/api/trace/lots:void';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const YYMMDD = TODAY.replace(/-/g, '').slice(2);

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'contract');
const schemaOf = (path: string): ValidateFunction => ajv.compile({
  $ref: `contract#/paths/${path.replace(/\//g, '~1')}/get/responses/200/content/application~1json/schema`,
});
function expectShape(path: string, body: unknown): void {
  const validate = schemaOf(path);
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface Row {
  lotId: number;
  lotNo: string;
  seq: number;
  lotQty: number;
  uomCode: string;
  package: { uomId: number; uomCode: string; count: number; qtyPerPackage: number } | null;
  creationModeCode: 'AUTO' | 'MANUAL';
  purchaseOrderLine: { purchaseOrderLineId: number; purchaseOrderNo: string; lineNo: number } | null;
  lifecycleStatusCode: string;
  lastLabelIssue: { issueSeq: number; issuedAt: string } | null;
  receivedAt: string | null;
  voidedAt: string | null;
}

interface LotsBody {
  items: Row[];
  page: { page: number; size: number; total: number };
  generation: { status: string; createdNow: number; creatableRemaining: number } | null;
}

describe('피처 014 S3 — 자재 관리 LOT P/O 미리 생성 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let narrowCookie: string;
  let popToken: string;
  let foreignPopToken: string;
  let mobileToken: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    narrowCookie = await makeUser('NARROW', ['W-01-01']);
    popToken = await terminalToken(ids.plant, 'POP');
    foreignPopToken = await terminalToken(ids.foreignPlant, 'POP');
    mobileToken = await terminalToken(ids.plant, 'MOBILE');
    fx = { app, issuer: terminalAuth(popToken, WORKER_NO), receiver: terminalAuth(mobileToken, WORKER_NO), businessDate: TODAY, keys };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const lotNo = (item: string, qty: number, serial: number): string =>
    `${PREFIX}-${item}|${String(qty)}|${YYMMDD}|${PREFIX}-S|${String(serial).padStart(4, '0')}`;

  it('Q1 US1-1·3·6 고르면 라인마다 100·100·50(패키징 5×10) / 100 이 미출력에 선다 — AUTO 묶음·몫 기록·번호·패키징 복사', async () => {
    const first = await makeOrder(ids.itemA, '2026-11-01', [250]);
    const second = await makeOrder(ids.itemA, '2026-11-05', [100]);
    const response = await lotsOf(ids.itemA, 'UNPRINTED', 1, 20).expect(200);
    expectShape('/logistics/material-lots', response.body);
    const body = response.body as LotsBody;

    expect(body.generation).toEqual({ status: 'OK', createdNow: 4, creatableRemaining: 0 });
    expect(body.page).toEqual({ page: 1, size: 20, total: 4 });
    expect(body.items.map((row) => [row.seq, row.lotQty, row.package?.count, row.package?.qtyPerPackage, row.package?.uomCode])).toEqual([
      [1, 100, 10, 10, 'BOX'], [2, 100, 10, 10, 'BOX'], [3, 50, 5, 10, 'BOX'], [4, 100, 10, 10, 'BOX'],
    ]);
    expect(body.items.map((row) => row.lotNo)).toEqual([lotNo('A', 100, 1), lotNo('A', 100, 2), lotNo('A', 50, 1), lotNo('A', 100, 3)]);
    expect(body.items.map((row) => row.purchaseOrderLine?.purchaseOrderLineId)).toEqual([
      first.lineIds[0], first.lineIds[0], first.lineIds[0], second.lineIds[0],
    ].map(Number));
    expect(body.items.every((row) => row.creationModeCode === 'AUTO' && row.uomCode === 'EA' && row.lastLabelIssue === null)).toBe(true);

    const batches = await prisma.material_lot_batch.findMany({ where: { item_id: ids.itemA }, orderBy: { material_lot_batch_id: 'asc' } });
    expect(batches.map((batch) => [batch.creation_mode_code, Number(batch.lot_qty), batch.lot_count, batch.created_channel_code, batch.created_worker_id]))
      .toEqual([['AUTO', 100, 2, 'POP', null], ['AUTO', 50, 1, 'POP', null], ['AUTO', 100, 1, 'POP', null]]);
    const plans = await prisma.material_lot_po_plan.findMany({ where: { lot_id: { in: body.items.map((row) => BigInt(row.lotId)) } } });
    expect(plans).toHaveLength(4);
  });

  it('Q1 US1-6 라인 245 → 나머지 45 를 50·패키징 5개로 올리고, 초과 5 는 다음 라인 몫에서 빠진다(100 → 95 → 100)', async () => {
    await makeOrder(ids.itemA2, '2026-11-01', [245]);
    await makeOrder(ids.itemA2, '2026-11-05', [100]);
    const body = (await lotsOf(ids.itemA2, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(body.items.map((row) => [row.lotQty, row.package?.count])).toEqual([[100, 10], [100, 10], [50, 5], [100, 10]]);
  });

  it('Q1 US5-3 T047 봉지당 양 소수 — 기본크기 2.5·패키징 5 에 남은 6.3 → 2.5(0.5×5)·2.5·1.5(0.5×3)', async () => {
    await makeOrder(ids.itemQ, '2026-11-01', [6.3]);
    const body = (await lotsOf(ids.itemQ, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(body.generation).toMatchObject({ status: 'OK', createdNow: 3 });
    expect(body.items.map((row) => [row.lotQty, row.package?.count, row.package?.qtyPerPackage])).toEqual([[2.5, 5, 0.5], [2.5, 5, 0.5], [1.5, 3, 0.5]]);
    expect(body.items.map((row) => row.lotNo)).toEqual([lotNo('Q', 2.5, 1), lotNo('Q', 2.5, 2), lotNo('Q', 1.5, 1)]);
    const lots = await prisma.lot.findMany({ where: { item_id: ids.itemQ }, orderBy: { lot_id: 'asc' } });
    expect(lots.map((lot) => [Number(lot.initial_qty), lot.package_count, Number(lot.qty_per_package)])).toEqual([[2.5, 5, 0.5], [2.5, 5, 0.5], [1.5, 3, 0.5]]);
  });

  it('Q2 US1-2 다시 골라도 새로 만들지 않는다 — 같은 LOT·같은 차례', async () => {
    const before = (await lotsOf(ids.itemA, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    const again = (await webLots(ids.itemA, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(again.generation).toEqual({ status: 'OK', createdNow: 0, creatableRemaining: 0 });
    expect(again.items.map((row) => row.lotId)).toEqual(before.items.map((row) => row.lotId));
  });

  it('Q2 US2-4 SC-002 같은 조합을 동시에 5번 골라도 몫(1,000)보다 많이 만들지 않는다', async () => {
    await makeOrder(ids.itemP, '2026-11-01', [1000]);
    const responses = await Promise.all(Array.from({ length: 5 }, () => lotsOf(ids.itemP, 'UNPRINTED', 1, 20)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const lots = await prisma.lot.findMany({ where: { item_id: ids.itemP, lifecycle_status_code: 'WAITING' } });
    expect(lots).toHaveLength(10);
    expect(lots.reduce((sum, lot) => sum + Number(lot.initial_qty), 0)).toBe(1000);
    expect(new Set(lots.map((lot) => lot.lot_no)).size).toBe(10);
  });

  it('Q4 US1-4 기본값 없는 품목 → NO_DEFAULT·행 없음, [만들기]로 만든 LOT 은 미출력에 보인다(MANUAL)', async () => {
    await makeOrder(ids.itemB, '2026-11-01', [300]);
    const empty = (await lotsOf(ids.itemB, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(empty).toMatchObject({ items: [], page: { total: 0 }, generation: { status: 'NO_DEFAULT', createdNow: 0 } });

    await request(app.getHttpServer()).post(BATCHES).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
      plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.itemB), lotQty: 30, package: null, lotCount: 2,
      businessDate: TODAY, occurredAt: new Date().toISOString(),
    }).expect(201);
    const manual = (await lotsOf(ids.itemB, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(manual.generation?.status).toBe('NO_DEFAULT');
    expect(manual.items.map((row) => [row.seq, row.lotQty, row.creationModeCode, row.purchaseOrderLine])).toEqual([[1, 30, 'MANUAL', null], [2, 30, 'MANUAL', null]]);
    expect(manual.page.total).toBe(2);
  });

  it('Q5 US1-5 기본값은 있는데 P/O 가 없으면 NO_OPEN_PO, 환산이 없으면 NO_CONVERSION', async () => {
    const none = (await lotsOf(ids.itemN, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(none).toMatchObject({ items: [], generation: { status: 'NO_OPEN_PO', createdNow: 0, creatableRemaining: 0 } });
    await makeOrder(ids.itemC, '2026-11-01', [100]);
    const conversion = (await lotsOf(ids.itemC, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(conversion).toMatchObject({ items: [], generation: { status: 'NO_CONVERSION' } });
  });

  it('Q14 US1-7 SC-004 품목 기본값을 바꿔도 만든 LOT 은 그대로, 새 몫부터 새 값', async () => {
    await makeOrder(ids.itemH, '2026-11-01', [300]);
    const first = (await lotsOf(ids.itemH, 'UNPRINTED', 1, 1).expect(200)).body as LotsBody;
    expect(first).toMatchObject({ page: { total: 3 }, generation: { createdNow: 1, creatableRemaining: 2 } });
    await prisma.item.update({ where: { item_id: ids.itemH }, data: { default_production_lot_size: 50, default_package_count: 5 } });

    const rest = (await lotsOf(ids.itemH, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(rest.items.map((row) => [row.lotQty, row.package?.count, row.package?.qtyPerPackage])).toEqual([
      [100, 10, 10], [50, 5, 10], [50, 5, 10], [50, 5, 10], [50, 5, 10],
    ]);
    expect(rest.items[0].lotId).toBe(first.items[0].lotId);
  });

  it('Q10 FR-009 출력 2·미출력 3 뒤 P/O 감량 → 아무것도 폐기하지 않고 더 만들지 않는다, 알림 칸도 없다', async () => {
    const order = await makeOrder(ids.itemE, '2026-11-01', [500]);
    const made = (await lotsOf(ids.itemE, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    for (const row of made.items.slice(0, 2)) await print(row.lotId);
    await prisma.purchase_order_line.update({ where: { purchase_order_line_id: order.lineIds[0] }, data: { ordered_qty: 200 } });

    const after = (await lotsOf(ids.itemE, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(after.generation).toEqual({ status: 'OK', createdNow: 0, creatableRemaining: 0 });
    expect(after.items).toHaveLength(3);
    const lots = await prisma.lot.findMany({ where: { item_id: ids.itemE } });
    expect(lots.map((lot) => lot.lifecycle_status_code)).toEqual(['WAITING', 'WAITING', 'WAITING', 'WAITING', 'WAITING']);
  });

  describe('받기·마감·폐기', () => {
    let lines: bigint[];
    let made: Row[];

    beforeAll(async () => {
      lines = [(await makeOrder(ids.itemF, '2026-11-01', [200])).lineIds[0], (await makeOrder(ids.itemF, '2026-11-05', [100])).lineIds[0]];
      made = ((await lotsOf(ids.itemF, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody).items;
    });

    it('Q11 자동 LOT 을 받은 뒤(마감 전) 다시 골라도 그 몫을 다시 만들지 않는다', async () => {
      expect(made.map((row) => row.lotQty)).toEqual([100, 100, 100]);
      // 다른 라인 몫인 LOT 부터 받아도 몫은 공급사·품목 합이다.
      await print(made[2].lotId);
      await print(made[1].lotId);
      await receiveScan(fx, { lotId: made[2].lotId });
      await receiveScan(fx, { lotId: made[1].lotId });

      const after = (await lotsOf(ids.itemF, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
      expect(after.generation).toEqual({ status: 'OK', createdNow: 0, creatableRemaining: 0 });
      expect(after.items.map((row) => row.lotId)).toEqual([made[0].lotId]);
    });

    it('Q9b 입하된 LOT 탭은 입하 마감 전까지만 — 받은 뒤(마감 전)에는 보인다', async () => {
      const received = (await lotsOf(ids.itemF, 'RECEIVED', 1, 20).expect(200)).body as LotsBody;
      expect(received.items.map((row) => row.lotId).sort()).toEqual([made[1].lotId, made[2].lotId].sort());
      expect(received.page.total).toBe(2);
      expect(received.items.every((row) => row.receivedAt !== null && row.lifecycleStatusCode === 'ACTIVE')).toBe(true);
    });

    it('Q12 FR-020 입하 마감 → 받은 양은 발주일 순 배정 그대로, 다시 골라도 몫 합이 맞다(중복·누락 없음)', async () => {
      const inbound = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(made[1].lotId) } });
      const closed = await closeInboundLotFixture(fx, Number(inbound.inbound_lot_id));
      expect(closed.poAllocations.map((allocation) => [allocation.purchaseOrderLineId, allocation.qty])).toEqual([[Number(lines[0]), 200]]);
      expect(Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: lines[0] } })).received_qty)).toBe(200);

      const after = (await lotsOf(ids.itemF, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
      expect(after.generation).toMatchObject({ createdNow: 0, creatableRemaining: 0 });
      const waiting = await prisma.lot.findMany({ where: { item_id: ids.itemF, lifecycle_status_code: 'WAITING' } });
      expect(waiting.reduce((sum, lot) => sum + Number(lot.initial_qty), 0) + 200).toBe(300);

      // 입하 마감하면 입하된 LOT 탭에서 빠진다(사용자 2026-11-24). 번호 스캔 찾기는 그대로 찾는다(Q19).
      const receivedAfterClose = (await lotsOf(ids.itemF, 'RECEIVED', 1, 20).expect(200)).body as LotsBody;
      expect(receivedAfterClose.items).toEqual([]);
      expect(receivedAfterClose.page.total).toBe(0);
    });

    it('Q13 자동 LOT 을 폐기하면 다시 고를 때 새 번호로 그 몫이 생긴다', async () => {
      await request(app.getHttpServer()).post(VOID).set('Cookie', cookie).set('Idempotency-Key', randomUUID())
        .send({ lotIds: [made[0].lotId] }).expect(200);
      const after = (await lotsOf(ids.itemF, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
      expect(after.generation).toMatchObject({ createdNow: 1, creatableRemaining: 0 });
      expect(after.items).toHaveLength(1);
      expect(after.items[0].lotNo).not.toBe(made[0].lotNo);
      expect(after.items[0].lotNo).toBe(lotNo('F', 100, 4));
    });

    it('Q9 US4-2·3·4 탭 넷 — 출력됨(입하 전)·입하된·폐기, 다른 탭 요청은 만들지 않는다', async () => {
      // 입하된 LOT 탭 내용은 Q9b(마감 전)·Q12(마감 뒤 빠짐)에서 본다 — 여기는 모양과 만들지 않음만.
      const received = (await lotsOf(ids.itemF, 'RECEIVED', 1, 20).expect(200)).body as LotsBody;
      expectShape('/logistics/material-lots', received);
      expect(received.generation).toBeNull();

      const voided = (await lotsOf(ids.itemF, 'VOIDED', 1, 20).expect(200)).body as LotsBody;
      expect(voided.items.map((row) => [row.lotId, row.voidedAt !== null])).toEqual([[made[0].lotId, true]]);

      const printedE = (await lotsOf(ids.itemE, 'PRINTED', 1, 20).expect(200)).body as LotsBody;
      expect(printedE.items).toHaveLength(2);
      expect(printedE.page.total).toBe(2);
      // 마지막 발행 최근 순 — 나중에 찍은 것이 먼저.
      const issued = printedE.items.map((row) => row.lastLabelIssue?.issuedAt as string);
      expect([...issued].sort().reverse()).toEqual(issued);
      const unprintedE = (await lotsOf(ids.itemE, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
      expect(unprintedE.items.map((row) => row.seq)).toEqual([1, 2, 3]);

      await makeOrder(ids.itemI, '2026-11-01', [300]);
      for (const tab of ['PRINTED', 'RECEIVED', 'VOIDED']) await lotsOf(ids.itemI, tab, 1, 20).expect(200);
      expect(await prisma.lot.count({ where: { item_id: ids.itemI } })).toBe(0);
    });

    it('Q19 US4-5 번호 스캔 찾기 — 맞는 조합·탭, 다른 공장·없는 번호는 404', async () => {
      const printedE = (await lotsOf(ids.itemE, 'PRINTED', 1, 20).expect(200)).body as LotsBody;
      const unprintedA = (await lotsOf(ids.itemA, 'UNPRINTED', 1, 1).expect(200)).body as LotsBody;
      for (const [no, tab, item] of [
        [unprintedA.items[0].lotNo, 'UNPRINTED', ids.itemA], [printedE.items[0].lotNo, 'PRINTED', ids.itemE],
        [made[1].lotNo, 'RECEIVED', ids.itemF], [made[0].lotNo, 'VOIDED', ids.itemF],
      ] as const) {
        const response = await popGet(LOOKUP).query({ plantId: Number(ids.plant), lotNo: no }).expect(200);
        expectShape('/logistics/material-lots/lookup', response.body);
        expect(response.body).toMatchObject({ tab, lot: { lotNo: no }, supplier: { supplierId: Number(ids.supplier) }, item: { itemId: Number(item) } });
      }
      const missing = await popGet(LOOKUP).query({ plantId: Number(ids.plant), lotNo: `${PREFIX}-없는번호` }).expect(404);
      expect(missing.body.errors[0].message).toBe('이 공장에 없는 자재 관리 LOT 번호입니다');
      await request(app.getHttpServer()).get(LOOKUP).set('Cookie', cookie)
        .query({ plantId: Number(ids.foreignPlant), lotNo: made[1].lotNo }).expect(404);
    });
  });

  it('Q3 US2-1·2 SC-003 몫 10,000 · 쪽 20 → 첫 요청 20개만(전체 100), 다음 쪽 20 더, 앞 쪽 다시는 안 만든다, size 201 은 400', async () => {
    await makeOrder(ids.itemD, '2026-11-01', [10000]);
    const started = Date.now();
    const first = (await lotsOf(ids.itemD, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console -- 응답 시간 기록(verification SC-003)
    console.log(`SC-003 미출력 첫 쪽(20개 생성) 응답 ${String(elapsed)}ms`);
    expect(elapsed).toBeLessThan(3000);
    expect(first).toMatchObject({ page: { total: 100 }, generation: { createdNow: 20, creatableRemaining: 80 } });
    expect(await prisma.lot.count({ where: { item_id: ids.itemD } })).toBe(20);

    const second = (await lotsOf(ids.itemD, 'UNPRINTED', 2, 20).expect(200)).body as LotsBody;
    expect(second).toMatchObject({ page: { total: 100 }, generation: { createdNow: 20, creatableRemaining: 60 } });
    expect(second.items.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, index) => 21 + index));
    expect(await prisma.lot.count({ where: { item_id: ids.itemD } })).toBe(40);

    const back = (await lotsOf(ids.itemD, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(back.generation).toMatchObject({ createdNow: 0, creatableRemaining: 60 });
    expect(back.items.map((row) => row.lotId)).toEqual(first.items.map((row) => row.lotId));
    await lotsOf(ids.itemD, 'UNPRINTED', 1, 201).expect(400);
  });

  it('Q16 FR-010·011 왼쪽 목록 — 발행 이력 없는 조합도, 찾기·쪽, 미출력·만들 수 있는 수(만들지 않음)·기본값 상태', async () => {
    await makeOrder(ids.itemJ, '2026-11-01', [250]);
    // 기본 정보(W-06-25)만 있는 조합 — 할 일이 없어 맨 뒤에 선다.
    await prisma.supplier_item_default.create({ data: { plant_id: ids.plant, supplier_id: ids.supplier, item_id: ids.itemN, lot_qty: 100 } });
    const lotsBefore = await prisma.lot.count({ where: { plant_id: ids.plant } });
    const all = await popGet(PAIRS).query({ plantId: Number(ids.plant), size: 200 }).expect(200);
    expectShape('/logistics/material-lot-pairs', all.body);
    expect(await prisma.lot.count({ where: { plant_id: ids.plant } })).toBe(lotsBefore);

    type Pair = { item: { itemId: number; code: string }; unprintedCount: number; creatableCount: number; defaultsStatus: string;
      lotDefaults: { lotQty: number; packageUomCode: string | null; packageCount: number | null } | null };
    const rows = all.body.items as Pair[];
    const row = (item: bigint) => rows.find((pair) => pair.item.itemId === Number(item));
    expect(row(ids.itemJ)).toMatchObject({ unprintedCount: 0, creatableCount: 3, defaultsStatus: 'OK',
      lotDefaults: { lotQty: 100, packageUomCode: 'BOX', packageCount: 10 } });
    expect(row(ids.itemA)).toMatchObject({ unprintedCount: 4, creatableCount: 0 });
    expect(row(ids.itemB)).toMatchObject({ defaultsStatus: 'NO_DEFAULT', unprintedCount: 2, lotDefaults: null });
    expect(row(ids.itemC)).toMatchObject({ defaultsStatus: 'NO_CONVERSION' });
    // 할 일(미출력 · P/O 남은 양)이 있는 조합이 먼저 선다 — 환산이 없어 못 만드는 C 도 남은 양이 있어 할 일이다.
    expect(row(ids.itemN)).toMatchObject({ unprintedCount: 0, creatableCount: 0, defaultsStatus: 'OK' });
    expect(rows[rows.length - 1].item.itemId).toBe(Number(ids.itemN));
    expect(rows.slice(0, -1).every((pair) => pair.unprintedCount + pair.creatableCount > 0 || pair.item.itemId === Number(ids.itemC))).toBe(true);
    const unprinted = await prisma.lot.count({ where: { plant_id: ids.plant, lifecycle_status_code: 'WAITING', document_issue_log: { none: {} } } });
    expect(all.body.summary).toEqual({ unprintedCount: unprinted });

    const found = await request(app.getHttpServer()).get(PAIRS).set('Cookie', cookie).query({ plantId: Number(ids.plant), q: `${PREFIX}-J` }).expect(200);
    expect((found.body.items as Pair[]).map((pair) => pair.item.code)).toEqual([`${PREFIX}-J`]);
    const paged = await popGet(PAIRS).query({ plantId: Number(ids.plant), page: 2, size: 2 }).expect(200);
    expect(paged.body.page).toEqual({ page: 2, size: 2, total: rows.length });
    expect(paged.body.items).toHaveLength(2);
  });

  it('Q16b FR-010 세 칸 — 공급사 목록(조합 셋을 공급사로 묶음·발행 이력 없는 공급사도·찾기·할 일 먼저·쪽, 합 = pairs 합, 만들지 않음)·pairs 공급사 거르기·출력됨·IQC·최근 발행', async () => {
    // 공급사 S0 — P/O 만 있음(할 일 있음, 발행 이력 없음). 공급사 R — 기본 정보만(할 일 없음, 코드가 S 보다 앞).
    ids.supplier0 = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S0`, partner_name: `${PREFIX} 둘째공급사` } })).partner_id;
    ids.supplierR = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-R`, partner_name: `${PREFIX} 한가한공급사` } })).partner_id;
    await makeOrder(ids.itemJ, '2026-11-02', [120], ids.supplier0);
    await prisma.supplier_item_default.create({ data: { plant_id: ids.plant, supplier_id: ids.supplierR, item_id: ids.itemN, lot_qty: 100 } });
    await prisma.item.update({ where: { item_id: ids.itemJ }, data: { inspection_required: true } });
    const lotsBefore = await prisma.lot.count({ where: { plant_id: ids.plant } });

    type Supplier = { supplier: { supplierId: number; code: string; name: string }; pairCount: number; unprintedCount: number; creatableCount: number };
    type Pair = { supplier: { supplierId: number }; item: { itemId: number }; unprintedCount: number; creatableCount: number;
      printedCount: number; inspectionRequired: boolean; lastIssuedAt: string | null };
    const all = await popGet(SUPPLIERS).query({ plantId: Number(ids.plant) }).expect(200);
    expectShape('/logistics/material-lot-suppliers', all.body);
    const suppliers = all.body.items as Supplier[];
    // 할 일 있는 공급사 먼저(코드 순 S · S0), 그다음 할 일 없는 R — 코드가 앞이어도 뒤에 선다.
    expect(suppliers.map((row) => row.supplier.code)).toEqual([`${PREFIX}-S`, `${PREFIX}-S0`, `${PREFIX}-R`]);
    expect(all.body.page).toEqual({ page: 1, size: 50, total: 3 });
    for (const row of suppliers) {
      const pairs = await popGet(PAIRS).query({ plantId: Number(ids.plant), supplierId: row.supplier.supplierId, size: 200 }).expect(200);
      expectShape('/logistics/material-lot-pairs', pairs.body);
      const items = pairs.body.items as Pair[];
      expect(items.every((pair) => pair.supplier.supplierId === row.supplier.supplierId)).toBe(true);
      expect(row.pairCount).toBe(items.length);
      expect(row.unprintedCount).toBe(items.reduce((sum, pair) => sum + pair.unprintedCount, 0));
      expect(row.creatableCount).toBe(items.reduce((sum, pair) => sum + pair.creatableCount, 0));
    }
    expect(suppliers[1]).toMatchObject({ pairCount: 1, unprintedCount: 0, creatableCount: 2 });
    expect(suppliers[2]).toMatchObject({ pairCount: 1, unprintedCount: 0, creatableCount: 0 });
    expect(suppliers[0].unprintedCount + suppliers[0].creatableCount).toBeGreaterThan(0);
    expect(await prisma.lot.count({ where: { plant_id: ids.plant } })).toBe(lotsBefore);

    // 찾기 — 품목 이름이면 그 품목을 가진 공급사, 공급사 이름·코드면 그 공급사. 찾기는 합도 그 조합만으로 낸다.
    const codesOf = async (q: string) => ((await popGet(SUPPLIERS).query({ plantId: Number(ids.plant), q }).expect(200)).body.items as Supplier[])
      .map((row) => row.supplier.code);
    expect(await codesOf('P/O미리생성자재J')).toEqual([`${PREFIX}-S`, `${PREFIX}-S0`]);
    // N 은 두 공급사 모두 할 일이 없다 — 공급사 코드 순.
    expect(await codesOf('P/O미리생성자재N')).toEqual([`${PREFIX}-R`, `${PREFIX}-S`]);
    expect(await codesOf('한가한')).toEqual([`${PREFIX}-R`]);
    expect(await codesOf(`${PREFIX}-S0`)).toEqual([`${PREFIX}-S0`]);
    const foundJ = (await request(app.getHttpServer()).get(SUPPLIERS).set('Cookie', cookie)
      .query({ plantId: Number(ids.plant), q: 'P/O미리생성자재J' }).expect(200)).body.items as Supplier[];
    expect(foundJ[0]).toMatchObject({ pairCount: 1, unprintedCount: 0, creatableCount: 3 });
    const paged = await popGet(SUPPLIERS).query({ plantId: Number(ids.plant), page: 2, size: 1 }).expect(200);
    expect(paged.body.page).toEqual({ page: 2, size: 1, total: 3 });
    expect((paged.body.items as Supplier[]).map((row) => row.supplier.code)).toEqual([`${PREFIX}-S0`]);
    await popGet(SUPPLIERS).query({ plantId: Number(ids.plant), size: 201 }).expect(400);

    // pairs 새 칸 — 출력됨(대기·라벨 있음), IQC, 최근 발행(그 조합 LOT 마지막 라벨 발행, 없으면 null).
    const rowsOf = async (supplierId: bigint) => (await popGet(PAIRS).query({ plantId: Number(ids.plant), supplierId: Number(supplierId), size: 200 })
      .expect(200)).body.items as Pair[];
    const ofS = await rowsOf(ids.supplier);
    const pairOf = (rows: Pair[], item: bigint) => rows.find((pair) => pair.item.itemId === Number(item));
    const lastE = await prisma.document_issue_log.aggregate({ _max: { issued_at: true },
      where: { document_type_code: 'MATERIAL_LOT_LABEL', lot: { item_id: ids.itemE } } });
    expect(pairOf(ofS, ids.itemE)).toMatchObject({ printedCount: 2, inspectionRequired: false, lastIssuedAt: lastE._max.issued_at?.toISOString() });
    // F 는 출력한 LOT 이 모두 입하·폐기됐다 — 출력됨 0, 최근 발행은 남는다.
    expect(pairOf(ofS, ids.itemF)).toMatchObject({ printedCount: 0 });
    expect(pairOf(ofS, ids.itemF)?.lastIssuedAt).not.toBeNull();
    expect(pairOf(ofS, ids.itemJ)).toMatchObject({ printedCount: 0, inspectionRequired: true, lastIssuedAt: null });
    // 공급사로 거른 품목 표는 최근 발행이 오래된 품목부터, 발행 이력 없는 품목은 맨 뒤(사용자 2026-11-24 · 시안 6판).
    const issuedOrder = ofS.map((pair) => pair.lastIssuedAt);
    const firstNull = issuedOrder.indexOf(null);
    const issued = (firstNull < 0 ? issuedOrder : issuedOrder.slice(0, firstNull)) as string[];
    expect(issued.length).toBeGreaterThan(1);
    expect(issued).toEqual([...issued].sort());
    if (firstNull >= 0) expect(issuedOrder.slice(firstNull).every((at) => at === null)).toBe(true);
    // 쪽을 나눠도 전체 순서 그대로 — 1쪽 끝과 2쪽 처음이 이어진다.
    const page1 = (await popGet(PAIRS).query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier), page: 1, size: 2 }).expect(200)).body.items as Pair[];
    const page2 = (await popGet(PAIRS).query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier), page: 2, size: 2 }).expect(200)).body.items as Pair[];
    expect([...page1, ...page2].map((pair) => pair.item.itemId)).toEqual(ofS.slice(0, 4).map((pair) => pair.item.itemId));
    expect((await rowsOf(ids.supplier0)).map((pair) => [pair.item.itemId, pair.inspectionRequired, pair.lastIssuedAt]))
      .toEqual([[Number(ids.itemJ), true, null]]);
    expect(await prisma.lot.count({ where: { plant_id: ids.plant } })).toBe(lotsBefore);
  });

  it('FR-001 FR-020 번호 충돌 없이 이어 매긴다 — 같은 접두사 번호가 이미 있으면 다음 일련', async () => {
    await makeOrder(ids.itemK, '2026-11-01', [100]);
    await request(app.getHttpServer()).post(BATCHES).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({
      plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.itemK), lotQty: 100, package: null, lotCount: 1,
      businessDate: TODAY, occurredAt: new Date().toISOString(),
    }).expect(201);
    const body = (await lotsOf(ids.itemK, 'UNPRINTED', 1, 20).expect(200)).body as LotsBody;
    expect(body.items.map((row) => [row.lotNo, row.creationModeCode])).toEqual([[lotNo('K', 100, 1), 'MANUAL'], [lotNo('K', 100, 2), 'AUTO']]);
  });

  it('Q16b P-01-01·W-01-14 가 없으면 403, 단말은 자기 공장 POP 만 — 쓰기 아닌 조회라 작업자 번호 없이 부른다', async () => {
    const narrow = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', narrowCookie);
    const combo = { plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.itemA), tab: 'UNPRINTED' };
    await narrow(LOTS).query(combo).expect(403);
    await narrow(PAIRS).query({ plantId: Number(ids.plant) }).expect(403);
    await narrow(SUPPLIERS).query({ plantId: Number(ids.plant) }).expect(403);
    await narrow(LOOKUP).query({ plantId: Number(ids.plant), lotNo: 'X' }).expect(403);
    for (const token of [foreignPopToken, mobileToken]) {
      await request(app.getHttpServer()).get(LOTS).set('Authorization', `Bearer ${token}`).query(combo).expect(401);
      await request(app.getHttpServer()).get(PAIRS).set('Authorization', `Bearer ${token}`).query({ plantId: Number(ids.plant) }).expect(401);
      await request(app.getHttpServer()).get(SUPPLIERS).set('Authorization', `Bearer ${token}`).query({ plantId: Number(ids.plant) }).expect(401);
    }
    await popGet(LOTS).query({ ...combo, tab: 'OTHER' }).expect(400);
  });

  function popGet(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${popToken}`);
  }

  function lotsOf(item: bigint, tab: string, page: number, size: number): request.Test {
    return popGet(LOTS).query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(item), tab, page, size });
  }

  function webLots(item: bigint, tab: string, page: number, size: number): request.Test {
    return request(app.getHttpServer()).get(LOTS).set('Cookie', cookie)
      .query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(item), tab, page, size });
  }

  async function print(lotId: number): Promise<void> {
    await request(app.getHttpServer()).post(ISSUES).set('Cookie', cookie).set('Idempotency-Key', randomUUID())
      .send({ documentTypeCode: 'MATERIAL_LOT_LABEL', targets: [{ targetTypeCode: 'LOT', targetId: lotId }] }).expect(201);
  }

  async function makeOrder(item: bigint, orderDate: string, quantities: number[], supplier = ids.supplier): Promise<{ orderId: bigint; lineIds: bigint[] }> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${String(seq).padStart(3, '0')}`, supplier_id: supplier, business_unit_id: ids.unit,
        plant_id: ids.plant, order_date: new Date(`${orderDate}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    const lineIds: bigint[] = [];
    for (const [index, ordered] of quantities.entries()) {
      lineIds.push((await prisma.purchase_order_line.create({
        data: { purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: item, uom_id: ids.ea, ordered_qty: ordered },
      })).purchase_order_line_id);
    }
    return { orderId: order.purchase_order_id, lineIds };
  }

  async function terminalToken(plant: bigint, type: 'POP' | 'MOBILE'): Promise<string> {
    seq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(seq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'P/O미리생성법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'P/O미리생성사업부' },
    })).business_unit_id;
    for (const [name, code] of [['plant', 'P'], ['foreignPlant', 'PF']] as const) {
      ids[name] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`,
          plant_name: `P/O미리생성공장 ${code}`, timezone_code: TZ },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.box = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'BOX' } })).uom_id;
    const items: [string, string, Record<string, unknown>][] = [
      ['itemA', 'A', {}], ['itemA2', 'A2', {}], ['itemP', 'P', {}], ['itemN', 'N', {}], ['itemH', 'H', {}], ['itemE', 'E', {}],
      ['itemF', 'F', {}], ['itemI', 'I', {}], ['itemD', 'D', { default_package_uom_id: null, default_package_count: null }],
      ['itemJ', 'J', {}], ['itemK', 'K', { default_package_uom_id: null, default_package_count: null }],
      ['itemQ', 'Q', { default_production_lot_size: 2.5, default_package_count: 5 }],
      ['itemB', 'B', { default_lot_storage_uom_id: null, default_production_lot_size: null, default_package_uom_id: null, default_package_count: null }],
      ['itemC', 'C', { default_lot_storage_uom_id: ids.box, default_production_lot_size: 1, default_package_uom_id: null, default_package_count: null }],
    ];
    for (const [name, code, overrides] of items) {
      ids[name] = (await prisma.item.create({
        data: { item_code: `${PREFIX}-${code}`, item_name: `P/O미리생성자재${code}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea,
          lot_controlled: true, inspection_required: false, default_lot_storage_uom_id: ids.ea, default_production_lot_size: 100,
          default_package_uom_id: ids.box, default_package_count: 10, ...overrides },
      })).item_id;
    }
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
    ids.worker = (await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: 'P/O미리생성작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `P/O미리생성 ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `P/O미리생성 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.document_issue_log WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE item_id IN (${items}))`,
      `DELETE FROM quality.inspection_plan WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.material_lot_po_plan WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.supplier_item_default WHERE plant_id IN (${plants})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (SELECT notification_event_id FROM app.notification_event WHERE aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))`,
      `DELETE FROM app.notification_event WHERE aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts})`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
