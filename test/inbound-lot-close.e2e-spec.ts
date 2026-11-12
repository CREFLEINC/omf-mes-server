/**
 * 피처 005 S5 — 입하 마감·P/O 자동 배정·마감 취소·IQC 요청·줄 축 배정 막기·입고 허브 칸(omf-all-around#254 · T037).
 * 받기·마감은 MOBILE 단말(M-01-01) + 작업자, 마감 취소는 M-01-03 계정. 응답은 ajv 로 계약 대조.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ClosedInboundLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, issueMaterialLots, passInboundLotIqc,
  receiveBody, receiveScan, receiveScans, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E5IC';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const YESTERDAY = localDate(new Date(Date.now() - 24 * 3600 * 1000), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const LOTS = '/api/logistics/inbound-lots';
const closePath = (id: number): string => `${LOTS}/${String(id)}:close-receipt`;
const reopenPath = (id: number): string => `${LOTS}/${String(id)}:reopen-receipt`;

const CONTRACT = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(CONTRACT, 'contract');
const schemaOf = (path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `contract#/paths/${path.replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});

function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

type Row = { inboundLotId: number; statusCode: string; reopenable: boolean; reopenReasonCode: string | null; reopenBlockerCode: string | null; reopened: boolean };

describe('피처 005 S5 — 입하 마감·자동 배정·마감 취소 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let closerCookie: string;
  let receiverCookie: string;
  let narrowCookie: string;
  let mobileToken: string;
  let popToken: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
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
    // 관리웹 판정의 검사자는 계정에 연결된 작업자다(#104).
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: '마감검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: ids.user, status_code: 'EMPLOYED' },
    });
    closerCookie = await makeUser('CLOSER', ['M-01-03']);
    receiverCookie = await makeUser('RECEIVER', ['M-01-01']);
    narrowCookie = await makeUser('NARROW', ['W-01-01']);
    mobileToken = await terminalToken('MOBILE');
    popToken = await terminalToken('POP');
    fx = {
      app, issuer: terminalAuth(popToken, WORKER_NO), receiver: terminalAuth(mobileToken, WORKER_NO), businessDate: DAY, keys,
      inspector: sessionAuth(cookie), prisma,
    };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const batch = (supplier: bigint, item: bigint, lotCount: number, lotQty = 1000): Parameters<typeof issueMaterialLots>[1] => ({
    plantId: Number(ids.plant), supplierId: Number(supplier), itemId: Number(item), lotQty, lotCount,
  });

  it('US2-2 카드 경로 :close-receipt → RECEIVED·배정 A 2,500·P/O 없음 500·받은 양 증가·IQC 요청 1건(대상 = LOT 전부)·인계 알림·RECEIPT_CLOSED', async () => {
    const order = await makeOrder(ids.supplierS, ids.itemA, '2026-11-01', [{ ordered: 2500 }]);
    const { inboundLot, lots } = await issueAndReceive(fx, batch(ids.supplierS, ids.itemA, 3));
    // 마감 전에는 IQC 요청이 없다(검사 대기열에 안 보인다).
    expect(await prisma.inspection_request.count({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) } })).toBe(0);

    const version = await versionOf(inboundLot.inboundLotId);
    const response = await mobilePost(closePath(inboundLot.inboundLotId)).send({ versionNo: version, occurredAt: `${DAY}T05:00:00.000Z` }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:close-receipt', 'post', 200), response.body);
    const closed = response.body as ClosedInboundLot;
    expect(closed).toMatchObject({ statusCode: 'RECEIVED', receivedQty: 3000, unallocatedQty: 500, versionNo: version + 1 });
    expect(closed.poAllocations).toEqual([expect.objectContaining({ purchaseOrderLineId: Number(order.lineIds[0]), lineNo: 1, qty: 2500 })]);
    expect(Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: order.lineIds[0] } })).received_qty)).toBe(2500);

    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(closed.inboundLotId) } });
    expect(row).toMatchObject({ status_code: 'RECEIVED', closed_automatically: false, received_closed_by: ids.worker, open_since_date: null });
    expect(row.received_closed_at?.toISOString()).toBe(`${DAY}T05:00:00.000Z`);
    const iqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) } });
    expect(iqc).toMatchObject({
      inspection_type_code: 'IQC', target_type_code: 'INBOUND_LOT', target_id: row.inbound_lot_id, inbound_lot_id: row.inbound_lot_id,
      lot_id: null, status_code: 'REQUESTED', item_id: ids.itemA,
    });
    expect(Number(iqc.target_qty)).toBe(lots.reduce((sum, lot) => sum + lot.lotQty, 0));
    // LOT 은 검사 대기 그대로 — 마감은 품질을 옮기지 않는다.
    expect((await prisma.lot.findMany({ where: { inbound_lot_id: row.inbound_lot_id } })).every((lot) => lot.status_code === 'INSPECTION_PENDING')).toBe(true);
    const header = await prisma.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: row.inbound_receipt_line_id }, select: { inbound_receipt: { select: { inbound_receipt_no: true } } },
    });
    const alerts = await prisma.notification_event.findMany({
      where: { event_type_code: 'IQC_INSPECTION_REQUESTED', aggregate_type_code: 'INBOUND_RECEIPT', aggregate_id: (await lineOf(closed.inboundLotId)).inbound_receipt_id },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toMatchObject({ receipt_no: header.inbound_receipt.inbound_receipt_no, lot_count: 3 });
    const event = await prisma.inbound_lot_event.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id, event_type_code: 'RECEIPT_CLOSED' } });
    expect(event).toMatchObject({ actor_worker_id: ids.worker, summary: expect.objectContaining({ auto: false, unallocatedQty: '500' }) });

    const detail = await get(`${LOTS}/${String(closed.inboundLotId)}`).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}', 'get', 200), detail.body);
    expect(detail.body.iqc).toMatchObject({ requestId: closed.iqcRequestId, requestNo: iqc.inspection_request_no, statusCode: 'REQUESTED' });
    expect(detail.body).toMatchObject({ reopenable: true, reopenReasonCode: 'NO_IQC_RESULT', reopened: false });
    // 같은 키로 다시 보내면 첫 결과(200)를 돌려주고 두 번 배정하지 않는다.
    expect(await prisma.inbound_receipt_po_allocation.count({ where: { inbound_receipt_line_id: row.inbound_receipt_line_id } })).toBe(1);
  });

  it('US2-3 마감 뒤 같은 S·A 를 스캔하면 새 입하 LOT 이 열린다', async () => {
    const first = await issueAndReceive(fx, batch(ids.supplierU, ids.itemA, 1));
    await closeInboundLotFixture(fx, first.inboundLot.inboundLotId);
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierU, ids.itemA, 1));
    const next = await receiveScan(fx, { lotId: lots[0].lotId });
    expect(next).toMatchObject({ created: true, autoClosedInboundLotNo: null, lotCount: 1 });
    expect(next.inboundLotId).not.toBe(first.inboundLot.inboundLotId);
  });

  it('US2-8 0031 잔량 300·0012 잔량 2,500·허용치 100 에 3,000 → 배정 300·2,600·P/O 없음 100 이 저장된다', async () => {
    const older = await makeOrder(ids.supplierT, ids.itemA, '2026-11-01', [{ ordered: 1000, received: 700 }], '0031');
    const newer = await makeOrder(ids.supplierT, ids.itemA, '2026-11-05', [{ ordered: 2500, tolerance: 100 }], '0012');
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierT, ids.itemA, 3));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(closed.poAllocations.map((row) => [row.purchaseOrderLineId, row.qty])).toEqual([
      [Number(older.lineIds[0]), 300], [Number(newer.lineIds[0]), 2600],
    ]);
    expect(closed.unallocatedQty).toBe(100);
    const rows = await prisma.inbound_receipt_po_allocation.findMany({ where: { inbound_receipt_line: { inbound_lot: { inbound_lot_id: BigInt(closed.inboundLotId) } } } });
    expect(rows.map((row) => Number(row.allocated_qty)).sort((a, b) => a - b)).toEqual([300, 2600]);
    expect(await receivedOf(older.lineIds[0])).toBe(1000);
    expect(await receivedOf(newer.lineIds[0])).toBe(2600);
  });

  it('US2-7 검사 불필요 품목 마감 → LOT 정상 그대로·요청 SKIPPED(기본 생략)·배정 계산·인계 알림 없음', async () => {
    const order = await makeOrder(ids.supplierS, ids.itemN, '2026-11-01', [{ ordered: 100 }]);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierS, ids.itemN, 2, 60));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(closed).toMatchObject({ statusCode: 'RECEIVED', unallocatedQty: 20 });
    expect(closed.poAllocations.map((row) => [row.purchaseOrderLineId, row.qty])).toEqual([[Number(order.lineIds[0]), 100]]);
    const iqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) } });
    expect(iqc).toMatchObject({ status_code: 'SKIPPED', skip_basis_code: 'DEFAULT', target_type_code: 'INBOUND_LOT', lot_id: null });
    expect((await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(closed.inboundLotId) } })).map((lot) => lot.status_code)).toEqual(['NORMAL', 'NORMAL']);
    const line = await lineOf(closed.inboundLotId);
    expect(await prisma.notification_event.count({ where: { event_type_code: 'IQC_INSPECTION_REQUESTED', aggregate_id: line.inbound_receipt_id } })).toBe(0);
  });

  it('US2-7 iqcDefaultSkipApplies — 검사 불필요·기본 생략 기준 있음 true, 기준 없음 false(마감해도 IQC 요청 없음), 검사 필요 false — 받기 카드·목록·상세', async () => {
    const cases = [[ids.supplierL1, ids.itemN, true], [ids.supplierL2, ids.itemO, false], [ids.supplierL3, ids.itemA, false]] as const;
    for (const [supplier, item, applies] of cases) {
      const { inboundLot } = await issueAndReceive(fx, batch(supplier, item, 1, 5));
      expect(inboundLot).toMatchObject({ iqcDefaultSkipApplies: applies });
      const list = await sessionGet(`${LOTS}?plantId=${String(ids.plant)}&closable=true&supplierId=${String(supplier)}`, closerCookie).expect(200);
      expectShape(schemaOf('/logistics/inbound-lots', 'get', 200), list.body);
      expect((list.body.items as { iqcDefaultSkipApplies: boolean }[]).map((row) => row.iqcDefaultSkipApplies)).toEqual([applies]);
      const detail = await sessionGet(`${LOTS}/${String(inboundLot.inboundLotId)}`, closerCookie).expect(200);
      expect(detail.body).toMatchObject({ iqcDefaultSkipApplies: applies });
      // 마감이 같은 판단을 쓴다 — 검사 불필요에서 true 면 생략 기록, false 면 요청 없음.
      const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
      if (item !== ids.itemA) expect(closed.iqcRequestId === null).toBe(!applies);
    }
  });

  it('US2-10 M-01-03 — closable=true 목록(입하 중만)·건별 해제·마감, 마감 뒤 해제는 409 STATE_LOCKED', async () => {
    const { inboundLot, lots } = await issueAndReceive(fx, batch(ids.supplierV, ids.itemA, 3, 10));
    const list = await sessionGet(`${LOTS}?plantId=${String(ids.plant)}&closable=true&supplierId=${String(ids.supplierV)}`, closerCookie).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots', 'get', 200), list.body);
    expect((list.body.items as Row[]).map((row) => [row.inboundLotId, row.statusCode])).toEqual([[inboundLot.inboundLotId, 'RECEIVING']]);
    const all = await sessionGet(`${LOTS}?plantId=${String(ids.plant)}&closable=true`, closerCookie).expect(200);
    expect((all.body.items as Row[]).every((row) => row.statusCode === 'RECEIVING')).toBe(true);

    await sessionPost(`${LOTS}/${String(inboundLot.inboundLotId)}:unregister-lots`, closerCookie)
      .send({ lotIds: [lots[0].lotId], versionNo: await versionOf(inboundLot.inboundLotId) }).expect(200);
    const closed = await sessionPost(closePath(inboundLot.inboundLotId), closerCookie)
      .send({ versionNo: await versionOf(inboundLot.inboundLotId), occurredAt: `${DAY}T05:00:00.000Z` }).expect(200);
    expect(closed.body).toMatchObject({ statusCode: 'RECEIVED', lotCount: 2, receivedQty: 20 });
    expect(await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) } }))
      .toMatchObject({ received_closed_by: null, closed_automatically: false });
    const again = await sessionPost(closePath(inboundLot.inboundLotId), closerCookie)
      .send({ versionNo: await versionOf(inboundLot.inboundLotId), occurredAt: `${DAY}T05:00:00.000Z` }).expect(409);
    expect(again.body.errors[0].code).toBe('STATE_LOCKED');
    const locked = await sessionPost(`${LOTS}/${String(inboundLot.inboundLotId)}:unregister-lots`, closerCookie)
      .send({ lotIds: [lots[1].lotId], versionNo: await versionOf(inboundLot.inboundLotId) }).expect(409);
    expect(locked.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('US2-12 마감 취소(검사 필요·결과 0건) → RECEIVING·open_since_date 오늘·IQC 요청 CANCELLED(CANCELLED_BY_REOPEN)·배정 삭제·받은 양 감소', async () => {
    const order = await makeOrder(ids.supplierW, ids.itemA, '2026-11-01', [{ ordered: 50 }]);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierW, ids.itemA, 2, 40));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(await receivedOf(order.lineIds[0])).toBe(50);
    const listed = await sessionGet(`${LOTS}?plantId=${String(ids.plant)}&reopenable=true`, closerCookie).expect(200);
    expect((listed.body.items as Row[]).find((row) => row.inboundLotId === closed.inboundLotId)).toMatchObject({ reopenReasonCode: 'NO_IQC_RESULT' });

    const response = await sessionPost(reopenPath(closed.inboundLotId), closerCookie).send({ versionNo: closed.versionNo, reason: '수량 다시 확인' }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:reopen-receipt', 'post', 200), response.body);
    expect(response.body).toMatchObject({ statusCode: 'RECEIVING', poAllocations: [], unallocatedQty: 80, iqc: null, reopened: true, reopenable: false, receivedClosedAt: null });
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(closed.inboundLotId) } });
    expect(row).toMatchObject({ status_code: 'RECEIVING', received_closed_at: null, received_closed_by: null, closed_automatically: false });
    expect(row.open_since_date?.toISOString().slice(0, 10)).toBe(DAY);
    expect(await receivedOf(order.lineIds[0])).toBe(0);
    expect(await prisma.inbound_receipt_po_allocation.count({ where: { inbound_receipt_line_id: row.inbound_receipt_line_id } })).toBe(0);
    const iqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) } });
    expect(iqc).toMatchObject({ status_code: 'CANCELLED', target_type_code: 'INBOUND_LOT', target_id: row.inbound_lot_id });
    expect((await requestEvents(iqc.inspection_request_id)).map((event) => event.event_type_code)).toEqual(['CANCELLED_BY_REOPEN']);
    const event = await prisma.inbound_lot_event.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id, event_type_code: 'RECEIPT_REOPENED' } });
    expect(event.reason).toBe('수량 다시 확인');
    // 다시 연 입하 LOT 에 같은 조합 스캔이 붙는다.
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierW, ids.itemA, 1, 40));
    expect(await receiveScan(fx, { lotId: lots[0].lotId })).toMatchObject({ inboundLotId: closed.inboundLotId, created: false, lotCount: 3 });
  });

  it('US2-12 마감 취소(검사 불필요·입고 전) → LOT 정상 그대로·SKIPPED 요청 CANCELLED', async () => {
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierX, ids.itemN, 2, 5));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const before = await get(`${LOTS}/${String(closed.inboundLotId)}`).expect(200);
    expect(before.body).toMatchObject({ reopenable: true, reopenReasonCode: 'INSPECTION_NOT_REQUIRED' });
    await sessionPost(reopenPath(closed.inboundLotId), closerCookie).send({ versionNo: closed.versionNo }).expect(200);
    expect(await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) } }))
      .toMatchObject({ status_code: 'CANCELLED', inbound_lot_id: BigInt(closed.inboundLotId) });
    expect((await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(closed.inboundLotId) } })).every((lot) => lot.status_code === 'NORMAL')).toBe(true);
  });

  it('US2-12 마감 취소(긴급 생략 실행·입고 전) → LOT NORMAL → INSPECTION_PENDING(C30)·검사 대기 보류 다시·SKIP_VOIDED·결재 무효 표시', async () => {
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierY, ids.itemA, 2, 5));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const lotIds = await simulateSkipExecuted(closed);
    const before = await get(`${LOTS}/${String(closed.inboundLotId)}`).expect(200);
    expect(before.body).toMatchObject({ reopenable: true, reopenReasonCode: 'IQC_SKIPPED' });

    await sessionPost(reopenPath(closed.inboundLotId), closerCookie).send({ versionNo: await versionOf(closed.inboundLotId) }).expect(200);
    const lots = await prisma.lot.findMany({ where: { lot_id: { in: lotIds } }, include: { lot_hold: true } });
    for (const lot of lots) {
      expect(lot.status_code).toBe('INSPECTION_PENDING');
      expect(lot.lot_hold.filter((hold) => hold.released_at === null).map((hold) => hold.reason_code)).toEqual(['INCOMING_INSPECTION_WAIT']);
    }
    const c30 = await prisma.lot_status_event.findMany({ where: { lot_id: { in: lotIds }, transition_code: 'C30' } });
    expect(c30.map((event) => [event.previous_status_code, event.new_status_code, event.source_document_type_code])).toEqual(
      lotIds.map(() => ['NORMAL', 'INSPECTION_PENDING', 'INBOUND_LOT']));
    expect((await requestEvents(BigInt(closed.iqcRequestId as number))).map((event) => event.event_type_code)).toEqual(['SKIP_VOIDED', 'CANCELLED_BY_REOPEN']);
    const approval = await prisma.approval_request.findFirstOrThrow({ where: { approval_request_no: `${PREFIX}-SKIP-${String(closed.inboundLotId)}` } });
    expect(approval.target_summary).toMatchObject({ voidedBy: 'RECEIPT_REOPENED' });
  });

  it('US2-12 막힘 — IQC_RECORDED·GOODS_RECEIVED·SKIP_PENDING·LEGACY_INBOUND_LOT·INBOUND_LOT_FINALIZED 는 409 errors[].code 이고 reopenable 목록에 없다', async () => {
    const recorded = await closedLot(ids.supplierZ, ids.itemA);
    await addDraftResult(recorded);
    const received = await closedLot(ids.supplierZ, ids.itemN);
    await receiveGoods(received.inboundLotId);
    const pending = await closedLot(ids.supplierZ2, ids.itemA);
    await makeSkipApproval(pending.inboundLotId, 'PENDING');
    const legacy = await closedLot(ids.supplierZ2, ids.itemN);
    await prisma.inbound_lot.update({ where: { inbound_lot_id: BigInt(legacy.inboundLotId) }, data: { erp_send_mode_code: 'PER_RECEIPT' } });
    const finalized = await closedLot(ids.supplierZ3, ids.itemA);
    await prisma.inbound_lot.update({ where: { inbound_lot_id: BigInt(finalized.inboundLotId) }, data: { status_code: 'FINALIZED', finalized_at: new Date() } });

    for (const [lot, code] of [[recorded, 'IQC_RECORDED'], [received, 'GOODS_RECEIVED'], [pending, 'SKIP_PENDING'],
      [legacy, 'LEGACY_INBOUND_LOT'], [finalized, 'INBOUND_LOT_FINALIZED']] as const) {
      const response = await sessionPost(reopenPath(lot.inboundLotId), closerCookie).send({ versionNo: await versionOf(lot.inboundLotId) }).expect(409);
      expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:reopen-receipt', 'post', 409), response.body);
      expect((response.body.errors as { code: string }[]).map((error) => error.code)).toEqual([code]);
    }
    const listed = await sessionGet(`${LOTS}?plantId=${String(ids.plant)}&reopenable=true&size=200`, closerCookie).expect(200);
    const listedIds = (listed.body.items as Row[]).map((row) => row.inboundLotId);
    for (const lot of [recorded, received, pending, legacy, finalized]) expect(listedIds).not.toContain(lot.inboundLotId);
    // G1 결정 — 같은 조합 입하 중 하나만 막는 건은 reopenable:false·reopenBlockerCode 로 함께 나온다.
    expect((listed.body.items as Row[]).every((row) => (row.reopenable ? row.reopenReasonCode !== null : row.reopenBlockerCode === 'OPEN_RECEIPT_EXISTS'))).toBe(true);
  });

  it('US2-13 같은 공급사·품목에 입하 중이 있으면 마감 취소 409 OPEN_RECEIPT_EXISTS(그 번호 함께)', async () => {
    const closed = await closedLot(ids.supplierZ4, ids.itemA);
    const open = await issueAndReceive(fx, batch(ids.supplierZ4, ids.itemA, 1, 5));
    const response = await sessionPost(reopenPath(closed.inboundLotId), closerCookie).send({ versionNo: closed.versionNo }).expect(409);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:reopen-receipt', 'post', 409), response.body);
    expect(response.body.errors).toEqual([expect.objectContaining({ code: 'OPEN_RECEIPT_EXISTS', message: expect.stringContaining(open.inboundLot.inboundLotNo) })]);
    expect(response.body.openInboundLotNo).toBe(open.inboundLot.inboundLotNo);
    const row = await get(`${LOTS}/${String(closed.inboundLotId)}`).expect(200);
    expect(row.body).toMatchObject({ statusCode: 'RECEIVED', reopenable: false, reopenReasonCode: null });
  });

  it('R22-1 마감 취소 뒤 다시 마감하면 배정을 처음부터 다시 계산하고 새 IQC 요청을 만든다(받은 양 일치)', async () => {
    const order = await makeOrder(ids.supplierZ5, ids.itemA, '2026-11-01', [{ ordered: 30 }, { ordered: 30 }]);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierZ5, ids.itemA, 2, 20));
    const first = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(first.poAllocations.map((row) => row.qty)).toEqual([30, 10]);
    await sessionPost(reopenPath(first.inboundLotId), closerCookie).send({ versionNo: first.versionNo }).expect(200);
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierZ5, ids.itemA, 1, 20));
    await receiveScan(fx, { lotId: lots[0].lotId });
    const second = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(second.poAllocations.map((row) => [row.purchaseOrderLineId, row.qty])).toEqual([[Number(order.lineIds[0]), 30], [Number(order.lineIds[1]), 30]]);
    expect(second.unallocatedQty).toBe(0);
    expect([await receivedOf(order.lineIds[0]), await receivedOf(order.lineIds[1])]).toEqual([30, 30]);
    expect(second.iqcRequestId).not.toBe(first.iqcRequestId);
    expect(await prisma.inspection_request.count({ where: { target_type_code: 'INBOUND_LOT', target_id: BigInt(first.inboundLotId) } })).toBe(2);
    // US2-12 — 옛 요청은 CANCELLED 로 같은 입하 LOT 칸을 유지하고, 새 요청이 «현재»다(유일 색인은 취소된 요청을 뺀다).
    const requests = await prisma.inspection_request.findMany({
      where: { inbound_lot_id: BigInt(first.inboundLotId) }, orderBy: { inspection_request_id: 'asc' }, select: { inspection_request_id: true, status_code: true },
    });
    expect(requests.map((row) => [Number(row.inspection_request_id), row.status_code])).toEqual([
      [first.iqcRequestId, 'CANCELLED'],
      [second.iqcRequestId, 'REQUESTED'],
    ]);
    expect((await get(`${LOTS}/${String(second.inboundLotId)}`).expect(200)).body.iqc).toMatchObject({ requestId: second.iqcRequestId, statusCode: 'REQUESTED' });
  });

  it('SC-003 마감된 입하 LOT 마다 배정 합 + P/O 없음 = 줄 수량, 라인마다 받은 양 ≤ 발주 + 허용치', async () => {
    const closed = await prisma.inbound_lot.findMany({
      where: { plant_id: ids.plant, status_code: 'RECEIVED' },
      include: { inbound_receipt_line: { include: { inbound_receipt_po_allocation: true } } },
    });
    expect(closed.length).toBeGreaterThan(5);
    const list = await get(`${LOTS}?plantId=${String(ids.plant)}&statusCode=RECEIVED&size=200`).expect(200);
    const unallocatedOf = new Map((list.body.items as { inboundLotId: number; unallocatedQty: number }[]).map((row) => [row.inboundLotId, row.unallocatedQty]));
    for (const row of closed) {
      const allocated = row.inbound_receipt_line.inbound_receipt_po_allocation.reduce((sum, allocation) => sum + Number(allocation.allocated_qty), 0);
      expect(allocated + (unallocatedOf.get(Number(row.inbound_lot_id)) ?? NaN)).toBe(Number(row.inbound_receipt_line.received_qty));
    }
    const lines = await prisma.purchase_order_line.findMany({ where: { purchase_order: { plant_id: ids.plant } } });
    for (const line of lines) expect(Number(line.received_qty)).toBeLessThanOrEqual(Number(line.ordered_qty) + Number(line.tolerance_over_qty));
  });

  it('R7-1 새 흐름 줄의 줄 축 배정 POST/DELETE 409 「W-01-16 에서 조정하세요」·초과분 목록·후보에서 빠짐 — 이전 데이터 줄은 그대로', async () => {
    await makeOrder(ids.supplierR, ids.itemA, '2026-11-01', [{ ordered: 5 }]);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierR, ids.itemA, 1, 20));
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(closed.unallocatedQty).toBe(15);
    // 마감 뒤 새 발주 — 줄 축 배정 후보가 될 수 있는 라인이 생겨도 새 흐름 줄은 W-01-16 몫이다.
    const order = await makeOrder(ids.supplierR, ids.itemA, '2026-11-02', [{ ordered: 100 }]);
    const line = await lineOf(closed.inboundLotId);
    const lineId = Number(line.inbound_receipt_line_id);
    const allocationPath = `/api/logistics/inbound-receipt-lines/${String(lineId)}/allocations`;
    const blocked = await webPost(allocationPath).send({ purchaseOrderLineId: Number(order.lineIds[0]), qty: 1 }).expect(409);
    expect(blocked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: expect.stringContaining('W-01-16') });
    const allocation = await prisma.inbound_receipt_po_allocation.findFirstOrThrow({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id } });
    await request(app.getHttpServer()).delete(`${allocationPath}/${String(allocation.inbound_receipt_po_allocation_id)}`)
      .set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).expect(409);
    expect(await prisma.inbound_receipt_po_allocation.count({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id } })).toBe(1);
    expect((await get(`/api/logistics/inbound-receipt-lines/${String(lineId)}/allocation-candidates`).expect(200)).body.items).toEqual([]);

    const legacyLineId = await makeLegacyLine(ids.supplierR, ids.itemA, 10);
    const unallocated = await get(`/api/logistics/inbound-unallocated?plantId=${String(ids.plant)}&supplierId=${String(ids.supplierR)}`).expect(200);
    expect((unallocated.body.items as { inboundReceiptLineId: number }[]).map((row) => row.inboundReceiptLineId)).toEqual([Number(legacyLineId)]);
    const candidates = await get(`/api/logistics/inbound-receipt-lines/${String(legacyLineId)}/allocation-candidates`).expect(200);
    expect((candidates.body.items as { purchaseOrderLineId: number }[]).map((row) => row.purchaseOrderLineId)).toEqual([Number(order.lineIds[0])]);
    await webPost(`/api/logistics/inbound-receipt-lines/${String(legacyLineId)}/allocations`)
      .send({ purchaseOrderLineId: Number(order.lineIds[0]), qty: 10 }).expect(201);
  });

  it('FR-035 입고 허브 행에 inboundLotId·inboundLotNo·package·allocatedQty — 마감 전 입하 LOT 는 배정이 없어 발주 아래 줄이 없다', async () => {
    const order = await makeOrder(ids.supplierQ, ids.itemA, '2026-11-01', [{ ordered: 15 }]);
    const { lots } = await issueMaterialLots(fx, { ...batch(ids.supplierQ, ids.itemA, 2, 10), package: { uomId: Number(ids.box), count: 2, qtyPerPackage: 5 } });
    const received = await receiveScans(fx, lots.map((lot) => lot.lotId));
    const inboundLotId = received[1].inboundLotId;
    const progressPath = `/api/logistics/purchase-orders/${String(order.orderId)}/inbound-progress`;
    expect((await get(progressPath).expect(200)).body.items).toEqual([]);

    await closeInboundLotFixture(fx, inboundLotId);
    const response = await get(progressPath).expect(200);
    expectShape(schemaOf('/logistics/purchase-orders/{purchaseOrderId}/inbound-progress', 'get', 200), response.body);
    const items = response.body.items as { lotNo: string; inboundLotId: number; inboundLotNo: string; package: unknown; allocatedQty: number; receivedQty: number }[];
    expect(items.map((row) => row.lotNo).sort()).toEqual(lots.map((lot) => lot.lotNo).sort());
    for (const row of items) {
      expect(row).toMatchObject({
        inboundLotId, inboundLotNo: received[1].inboundLotNo, allocatedQty: 15, receivedQty: 10,
        package: { uomId: Number(ids.box), uomCode: 'BOX', count: 2, qtyPerPackage: 5 },
      });
    }
  });

  it('US2-11(받기 때 확인) 지난 날짜에 연 입하 LOT 은 다음 날 같은 조합 스캔이 먼저 자동 마감하고 새로 연다 — 시스템 행위자·자동 표시', async () => {
    await makeOrder(ids.supplierP, ids.itemA, '2026-11-01', [{ ordered: 7 }]);
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierP, ids.itemA, 2, 5));
    const at = `${YESTERDAY}T03:00:00.000Z`;
    const yesterday = await fx.receiver(request(app.getHttpServer()).post(`${LOTS}:receive`)).set('Idempotency-Key', idempotencyKey(fx))
      .send(receiveBody(fx, [{ lotId: lots[0].lotId }], { businessDate: YESTERDAY, occurredAt: at, receiptDatetime: at })).expect(201);
    const stale = yesterday.body.inboundLots[0] as { inboundLotId: number; inboundLotNo: string };

    const today = await receiveScan(fx, { lotId: lots[1].lotId });
    expect(today).toMatchObject({ created: true, autoClosedInboundLotNo: stale.inboundLotNo, lotCount: 1 });
    expect(today.inboundLotId).not.toBe(stale.inboundLotId);
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(stale.inboundLotId) } });
    expect(row).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true, received_closed_by: null });
    const event = await prisma.inbound_lot_event.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id, event_type_code: 'RECEIPT_CLOSED' } });
    expect(event).toMatchObject({ actor_user_id: null, actor_worker_id: null, summary: expect.objectContaining({ auto: true, unallocatedQty: '0' }) });
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id } });
    expect(iqc).toMatchObject({ status_code: 'REQUESTED', created_by: null });
    const line = await lineOf(stale.inboundLotId);
    const alert = await prisma.notification_event.findFirstOrThrow({ where: { event_type_code: 'IQC_INSPECTION_REQUESTED', aggregate_id: line.inbound_receipt_id } });
    const receipt = await prisma.inbound_receipt.findUniqueOrThrow({ where: { inbound_receipt_id: line.inbound_receipt_id } });
    expect(alert.payload).toMatchObject({ receipt_no: `${receipt.inbound_receipt_no} (자동 마감)` });
    const listed = await get(`${LOTS}?plantId=${String(ids.plant)}&closedAutomatically=true`).expect(200);
    expect((listed.body.items as Row[]).map((item) => item.inboundLotId)).toEqual([stale.inboundLotId]);
  });

  it('T040 passInboundLotIqc — 마감 → 합격 결과 → 결과 :confirm, LOT 전부 정상·요청 COMPLETED·종합 판정·확정 시각. 그 뒤 마감 취소는 IQC_RECORDED', async () => {
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierO, ids.itemA, 2, 5));
    const passed = await passInboundLotIqc(fx, inboundLot.inboundLotId);
    expect(passed).toHaveLength(2);
    const response = await sessionPost(reopenPath(inboundLot.inboundLotId), closerCookie).send({ versionNo: await versionOf(inboundLot.inboundLotId) }).expect(409);
    expect((response.body.errors as { code: string }[]).map((error) => error.code)).toEqual(['IQC_RECORDED']);
  });

  it('R19-1 권한 — 마감 취소는 M-01-03 만(M-01-01 403), 마감은 M-01-01·M-01-03(W-01-01 403), 단말은 MOBILE·X-Worker-No', async () => {
    const closed = await closedLot(ids.supplierN, ids.itemA);
    await sessionPost(reopenPath(closed.inboundLotId), receiverCookie).send({ versionNo: closed.versionNo }).expect(403);
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierN, ids.itemA, 1, 5));
    const body = { versionNo: await versionOf(inboundLot.inboundLotId), occurredAt: `${DAY}T05:00:00.000Z` };
    await sessionPost(closePath(inboundLot.inboundLotId), narrowCookie).send(body).expect(403);
    await terminalAuth(popToken, WORKER_NO)(request(app.getHttpServer()).post(closePath(inboundLot.inboundLotId)))
      .set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(401);
    await request(app.getHttpServer()).post(closePath(inboundLot.inboundLotId)).set('Authorization', `Bearer ${mobileToken}`)
      .set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(401);
    await sessionPost(closePath(inboundLot.inboundLotId), receiverCookie).send(body).expect(200);
  });

  it('마감 20라인 — P/O 라인 20개에 자동 배정해도 2초 안이다', async () => {
    const order = await makeOrder(ids.supplierM, ids.itemA, '2026-11-01', Array.from({ length: 20 }, () => ({ ordered: 5 })));
    const { inboundLot } = await issueAndReceive(fx, batch(ids.supplierM, ids.itemA, 20, 5));
    const started = Date.now();
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(closed.poAllocations).toHaveLength(20);
    expect(closed.poAllocations.map((row) => row.purchaseOrderLineId)).toEqual(order.lineIds.map(Number));
    expect(closed.unallocatedQty).toBe(0);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function sessionGet(path: string, sessionCookie: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', sessionCookie);
  }

  function webPost(path: string): request.Test {
    return sessionPost(path, cookie);
  }

  function sessionPost(path: string, sessionCookie: string): request.Test {
    return sessionAuth(sessionCookie)(request(app.getHttpServer()).post(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  function mobilePost(path: string): request.Test {
    return terminalAuth(mobileToken, WORKER_NO)(request(app.getHttpServer()).post(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  async function versionOf(inboundLotId: number): Promise<number> {
    return (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } })).version_no;
  }

  async function lineOf(inboundLotId: number) {
    return (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) }, include: { inbound_receipt_line: true } }))
      .inbound_receipt_line;
  }

  async function receivedOf(lineId: bigint): Promise<number> {
    return Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: lineId } })).received_qty);
  }

  function requestEvents(requestId: bigint) {
    return prisma.inspection_request_event.findMany({ where: { inspection_request_id: requestId }, orderBy: { inspection_request_event_id: 'asc' } });
  }

  async function closedLot(supplier: bigint, item: bigint): Promise<ClosedInboundLot> {
    const { inboundLot } = await issueAndReceive(fx, batch(supplier, item, 1, 5));
    return closeInboundLotFixture(fx, inboundLot.inboundLotId);
  }

  async function makeOrder(
    supplier: bigint, item: bigint, orderDate: string, lines: { ordered: number; received?: number; tolerance?: number }[], no?: string,
  ): Promise<{ orderId: bigint; lineIds: bigint[] }> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${no ?? String(seq)}-${String(seq)}`, supplier_id: supplier, business_unit_id: ids.unit,
        plant_id: ids.plant, order_date: new Date(`${orderDate}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    const lineIds: bigint[] = [];
    for (const [index, line] of lines.entries()) {
      lineIds.push((await prisma.purchase_order_line.create({
        data: {
          purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: item, uom_id: ids.ea,
          ordered_qty: line.ordered, received_qty: line.received ?? 0, tolerance_over_qty: line.tolerance ?? 0,
        },
      })).purchase_order_line_id);
    }
    return { orderId: order.purchase_order_id, lineIds };
  }

  /** 긴급 생략 «실행»의 흔적 — 그 뒤 상태(요청 SKIPPED·APPROVAL, LOT 정상·보류 해제, 결재 승인)를 그대로 세운다. */
  async function simulateSkipExecuted(closed: ClosedInboundLot): Promise<bigint[]> {
    const lotIds = (await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(closed.inboundLotId) }, select: { lot_id: true } })).map((lot) => lot.lot_id);
    await prisma.inspection_request.update({ where: { inspection_request_id: BigInt(closed.iqcRequestId as number) }, data: { status_code: 'SKIPPED', skip_basis_code: 'APPROVAL' } });
    await prisma.lot_hold.updateMany({ where: { lot_id: { in: lotIds }, released_at: null }, data: { released_at: new Date(), released_by: ids.user, release_reason_code: 'INCOMING_INSPECTION_SKIPPED' } });
    await prisma.lot.updateMany({ where: { lot_id: { in: lotIds } }, data: { status_code: 'NORMAL' } });
    await makeSkipApproval(closed.inboundLotId, 'APPROVED');
    return lotIds;
  }

  /** IQC 생략 결재 — 대상은 입하 LOT 이다(FR-032). */
  async function makeSkipApproval(inboundLotId: number, status: string): Promise<void> {
    await prisma.approval_request.create({
      data: {
        approval_request_no: `${PREFIX}-SKIP-${String(inboundLotId)}`, approval_type_code: 'IQC_SKIP', target_type_code: 'INBOUND_LOT',
        target_id: BigInt(inboundLotId), requested_by: ids.user, requested_at: new Date(), status_code: status, reason: '긴급 생산',
      },
    });
  }

  async function addDraftResult(closed: ClosedInboundLot): Promise<void> {
    // 2026-11-12 매칭 필수 — 입하 LOT 의 자재 관리 LOT 하나를 매칭한다.
    const lot = await prisma.lot.findFirstOrThrow({ where: { inbound_lot_id: BigInt(closed.inboundLotId) }, orderBy: { lot_no: 'asc' } });
    await webPost('/api/quality/inspection-results').send({
      inspectionRequestId: closed.iqcRequestId, inspectedQty: 5, acceptedQty: 5, rejectedQty: 0, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', matchedLotIds: [Number(lot.lot_id)],
    }).expect(201);
  }

  async function receiveGoods(inboundLotId: number): Promise<void> {
    const lot = await prisma.lot.findFirstOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } });
    seq += 1;
    const receipt = await prisma.goods_receipt.create({
      data: { goods_receipt_no: `${PREFIX}-GR-${String(seq)}`, receipt_type_code: 'MATERIAL', plant_id: ids.plant, warehouse_id: ids.warehouse,
        receipt_datetime: new Date(), status_code: 'POSTED' },
    });
    await prisma.goods_receipt_line.create({
      data: { goods_receipt_id: receipt.goods_receipt_id, line_no: 1, item_id: lot.item_id, lot_id: lot.lot_id, receipt_qty: lot.initial_qty,
        uom_id: lot.uom_id, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: ids.location },
    });
  }

  /** 이전 데이터 줄 — 입하 LOT 이 PER_RECEIPT(마감됨)이고 줄에 LOT 하나(데이터 이전 1). */
  async function makeLegacyLine(supplier: bigint, item: bigint, qty: number): Promise<bigint> {
    seq += 1;
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-${String(seq)}`, supplier_id: supplier, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: item, supplier_id: supplier, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(),
        erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    return line.inbound_receipt_line_id;
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입하마감법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입하마감사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '입하마감공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.box = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'BOX' } })).uom_id;
    for (const [name, code, required] of [['itemA', 'A', true], ['itemN', 'N', false], ['itemO', 'O', false]] as const) {
      ids[name] = (await prisma.item.create({
        data: { item_code: `${PREFIX}-${code}`, item_name: `입하마감자재${code}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea,
          lot_controlled: true, inspection_required: required },
      })).item_id;
    }
    // 검사 불필요 품목의 품목 전용 IQC 기준 「기본 생략」 — 마감이 생략(DEFAULT) 기록을 남긴다(#215).
    const plan = await prisma.inspection_plan.create({
      data: { inspection_plan_code: `${PREFIX}-IQC-N`, inspection_plan_name: '입하마감 기본 생략', inspection_type_code: 'IQC', item_id: ids.itemN, default_skip: true },
    });
    await prisma.inspection_plan_version.create({
      data: { inspection_plan_id: plan.inspection_plan_id, plan_version: 1, effective_from: new Date('2026-01-01T00:00:00.000Z'),
        sampling_method_code: 'FULL', inspection_frequency_code: 'EVERY_LOT', status_code: 'CONFIRMED' },
    });
    for (const code of ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Z2', 'Z3', 'Z4', 'Z5', 'R', 'Q', 'P', 'O', 'N', 'M', 'L1', 'L2', 'L3']) {
      ids[`supplier${code}`] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${code}`, partner_name: `${PREFIX} 공급사 ${code}` } })).partner_id;
    }
    ids.worker = (await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '마감작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '입하마감창고',
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.location = (await prisma.location.create({
      data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L1`, location_name: '입하마감위치' },
    })).location_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `입하마감 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `입하마감 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.approval_request WHERE approval_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.lot_four_m_change WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.item_inspection_level_history WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
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
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
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
