/**
 * 피처 005 S12 — W-01-16 입하/입고 작업 기록: 목록 칸·「마감 승인 대기」·P/O 배정 수정·최종 마감·불변(omf-all-around#254 · T097).
 * 입하 LOT 은 도우미(발행 → `:receive` → 마감 → IQC 합격)로, 입고는 입고 API 로 만든다. 처분·반품·입고 취소 요청 같은 «끝남» 재료는
 * 쓰기 경로가 무거워 직접 세운다. 응답은 ajv 로 계약 대조. ⛔ 최종 마감 때 ERP 적재는 #265 — 여기서는 아웃박스 변화 없음까지.
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
  InboundLotFixture, IssuedMaterialLot, closeInboundLotFixture, idempotencyKey, issueAndReceive, passInboundLotIqc, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E12F';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const LOTS = '/api/logistics/inbound-lots';
const candidatesPath = (id: number): string => `${LOTS}/${String(id)}/allocation-candidates`;
const allocationsPath = (id: number): string => `${LOTS}/${String(id)}/po-allocations`;
const finalizePath = (id: number): string => `${LOTS}/${String(id)}:finalize`;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object, 'contract');
const schemaOf = (path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `contract#/paths/${path.replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
const LIST = schemaOf('/logistics/inbound-lots', 'get', 200);
const DETAIL = schemaOf('/logistics/inbound-lots/{inboundLotId}', 'get', 200);

function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface Row {
  inboundLotId: number;
  statusCode: string;
  versionNo: number;
  finalizable: boolean;
  finalizeBlockers: { code: string; lotNos: string[] }[];
  unallocatedQty: number;
  poAllocations: { purchaseOrderLineId: number; qty: number; excessQty: number }[];
}

interface Passed {
  inboundLotId: number;
  lots: IssuedMaterialLot[];
}

describe('피처 005 S12 — W-01-16 배정 수정·최종 마감·불변 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let viewerCookie: string;
  let outsiderCookie: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
  let seq = 0;
  /** US8-1 의 입하 LOT(P/O 20 · P/O 없음 10 · 전량 입고) — US8-4 가 최종 마감하고 US8-5 가 불변을 본다. */
  let full: Passed & { goodsReceiptId: number; lineId: bigint };
  let fullOrderLine: bigint;

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
    await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W2`, worker_name: '작업기록검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: ids.user, status_code: 'EMPLOYED' },
    });
    viewerCookie = await makeUser('VIEWER', ['W-01-01']);
    outsiderCookie = await makeUser('OUTSIDER', ['W-01-10']);
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma,
    };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US8-1 erpSendModeCode=ON_FINALIZE 행 — poAllocations(excessQty)·P/O 없음·입하/입고 수량·lotProgress·iqc·자동 마감·finalizable, 이전 데이터 없음', async () => {
    fullOrderLine = (await makeOrder(ids.s1, '2026-11-01', [{ ordered: 20 }])).lineIds[0];
    const passed = await passedLot(ids.s1, 3, 10);
    const goodsReceiptId = await receiveGoods(passed.lots);
    full = { ...passed, goodsReceiptId, lineId: (await inboundLotRow(passed.inboundLotId)).inbound_receipt_line_id };
    const legacy = await makeLegacyLot(ids.s1, 7);

    const response = await get(`${LOTS}?plantId=${String(ids.plant)}&erpSendModeCode=ON_FINALIZE&supplierId=${String(ids.s1)}`).expect(200);
    expectShape(LIST, response.body);
    const items = response.body.items as Row[];
    expect(items.map((row) => row.inboundLotId)).toEqual([full.inboundLotId]);
    expect(items[0]).toMatchObject({
      statusCode: 'RECEIVED', receivedQty: 30, goodsReceivedQty: 30, unallocatedQty: 10, closedAutomatically: false, finalizable: true,
      finalizeBlockers: [], finalizedAt: null, finalizedByName: null, erpSendModeCode: 'ON_FINALIZE',
      lotProgress: { received: 3, inIqc: 0, inDisposition: 0, disposed: 0, returned: 0 },
      iqc: expect.objectContaining({ statusCode: 'COMPLETED', overallJudgmentCode: 'ACCEPTED' }),
      poAllocations: [expect.objectContaining({ purchaseOrderLineId: Number(fullOrderLine), qty: 20, excessQty: 0 })],
    });
    const legacyRows = await get(`${LOTS}?plantId=${String(ids.plant)}&erpSendModeCode=PER_RECEIPT`).expect(200);
    expect((legacyRows.body.items as Row[]).map((row) => row.inboundLotId)).toEqual([legacy]);
  });

  it('US8-2 finalizable=true — IQC 중·처분 중·입고 취소 요청 중·입고 안 됨은 빠지고, 입고·폐기·반품으로 끝나면 포함·상세 finalizeBlockers', async () => {
    const iqc = await issueAndReceive(fx, batch(ids.s2, 2, 5));
    await closeInboundLotFixture(fx, iqc.inboundLot.inboundLotId);
    const disposing = await passedLot(ids.s3, 2, 5);
    await receiveGoods([disposing.lots[0]]);
    await openNonconformance(disposing.lots[1]);
    const cancelling = await passedLot(ids.s4, 1, 5);
    const pendingReceipt = await receiveGoods(cancelling.lots);
    await prisma.goods_receipt.update({ where: { goods_receipt_id: BigInt(pendingReceipt) }, data: { status_code: 'CANCEL_REQUESTED' } });
    const waiting = await passedLot(ids.s5, 1, 5);
    const done = await passedLot(ids.s6, 3, 5);
    await receiveGoods([done.lots[0]]);
    await prisma.lot.update({ where: { lot_id: BigInt(done.lots[1].lotId) }, data: { status_code: 'SCRAPPED' } });
    await supplierReturn(done.lots[2]);

    const finalizable = await get(`${LOTS}?plantId=${String(ids.plant)}&erpSendModeCode=ON_FINALIZE&finalizable=true&size=200`).expect(200);
    expectShape(LIST, finalizable.body);
    const listed = (finalizable.body.items as Row[]).map((row) => row.inboundLotId);
    expect(listed).toEqual(expect.arrayContaining([done.inboundLotId, full.inboundLotId]));
    for (const lot of [iqc.inboundLot.inboundLotId, disposing.inboundLotId, cancelling.inboundLotId, waiting.inboundLotId]) expect(listed).not.toContain(lot);

    // 클라 「진행 중」 보기 — 입하 중·입하 완료 중 마감 승인 대기가 아닌 것, 행에 이유.
    const progress = await get(`${LOTS}?plantId=${String(ids.plant)}&statusCode=RECEIVING,RECEIVED&finalizable=false&size=200`).expect(200);
    const blockersOf = new Map((progress.body.items as Row[]).map((row) => [row.inboundLotId, row.finalizeBlockers]));
    expect(blockersOf.get(iqc.inboundLot.inboundLotId)).toEqual([{ code: 'IQC_IN_PROGRESS', lotNos: iqc.lots.map((lot) => lot.lotNo).sort() }]);
    expect(blockersOf.get(disposing.inboundLotId)).toEqual([{ code: 'DISPOSITION_IN_PROGRESS', lotNos: [disposing.lots[1].lotNo] }]);
    expect(blockersOf.get(cancelling.inboundLotId)).toEqual([{ code: 'RECEIPT_CANCEL_PENDING', lotNos: [cancelling.lots[0].lotNo] }]);
    expect(blockersOf.get(waiting.inboundLotId)).toEqual([{ code: 'NOT_RECEIVED', lotNos: [waiting.lots[0].lotNo] }]);
    expect(blockersOf.has(done.inboundLotId)).toBe(false);

    const detail = await get(`${LOTS}/${String(done.inboundLotId)}`).expect(200);
    expectShape(DETAIL, detail.body);
    expect(detail.body).toMatchObject({ finalizable: true, finalizeBlockers: [], lotProgress: { received: 1, disposed: 1, returned: 1 } });
    expect((detail.body.lots as { lotNo: string; goodsReceived: boolean; dispositionStatusCode: string | null }[])
      .map((lot) => [lot.lotNo, lot.goodsReceived, lot.dispositionStatusCode])).toEqual([
      [done.lots[0].lotNo, true, null], [done.lots[1].lotNo, false, 'DISPOSED'], [done.lots[2].lotNo, false, 'RETURNED'],
    ]);
    const disposingDetail = await get(`${LOTS}/${String(disposing.inboundLotId)}`).expect(200);
    expect(disposingDetail.body).toMatchObject({ finalizable: false, finalizeBlockers: [{ code: 'DISPOSITION_IN_PROGRESS', lotNos: [disposing.lots[1].lotNo] }] });
    expect((disposingDetail.body.lots as { dispositionStatusCode: string | null }[]).map((lot) => lot.dispositionStatusCode)).toEqual([null, 'IN_PROGRESS']);
  });

  it('US8-3 allocation-candidates(maxQty·thisLotQty·마감 뒤 생긴 라인) → PUT po-allocations 전체 교체·받은 양 차이 증감·ALLOCATION_EDITED·재고·LOT·입고 불변, 한도·합·후보 아님·같은 라인 400', async () => {
    const older = await makeOrder(ids.s7, '2026-10-01', [{ ordered: 25 }]);
    // 마감 시각을 지금으로 — 그 뒤에 만든 라인이 「마감 뒤 생김」이다.
    const { inboundLot } = await issueAndReceive(fx, batch(ids.s7, 3, 10));
    await closeInboundLotFixture(fx, inboundLot.inboundLotId, new Date().toISOString());
    const passed = { inboundLotId: inboundLot.inboundLotId, lots: await passInboundLotIqc(fx, inboundLot.inboundLotId) };
    await receiveGoods(passed.lots);
    const newer = await makeOrder(ids.s7, '2026-11-05', [{ ordered: 10, tolerance: 2 }]);
    const foreign = await makeOrder(ids.s8, '2026-10-01', [{ ordered: 100 }]);
    const [lineA, lineB] = [older.lineIds[0], newer.lineIds[0]];

    const candidates = await get(candidatesPath(passed.inboundLotId)).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}/allocation-candidates', 'get', 200), candidates.body);
    expect(candidates.body.items).toEqual([
      expect.objectContaining({ purchaseOrderLineId: Number(lineA), orderedQty: 25, receivedQty: 25, toleranceQty: 0, thisLotQty: 25, maxQty: 25, openedAfterReceiptClose: false }),
      expect.objectContaining({ purchaseOrderLineId: Number(lineB), orderedQty: 10, receivedQty: 0, toleranceQty: 2, thisLotQty: 0, maxQty: 12, openedAfterReceiptClose: true }),
    ]);

    const before = await stockSnapshot(passed);
    const version = await versionOf(passed.inboundLotId);
    const saved = await put(allocationsPath(passed.inboundLotId)).send({
      versionNo: version, allocations: [{ purchaseOrderLineId: Number(lineA), qty: 20 }, { purchaseOrderLineId: Number(lineB), qty: 10 }],
    }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}/po-allocations', 'put', 200), saved.body);
    expect(saved.body).toMatchObject({ versionNo: version + 1, unallocatedQty: 0, receivedQty: 30 });
    expect((saved.body.poAllocations as Row['poAllocations']).map((row) => [row.purchaseOrderLineId, row.qty, row.excessQty])).toEqual([
      [Number(lineA), 20, 0], [Number(lineB), 10, 0],
    ]);
    expect([await receivedOf(lineA), await receivedOf(lineB)]).toEqual([20, 10]);
    const event = await prisma.inbound_lot_event.findFirstOrThrow({ where: { inbound_lot_id: BigInt(passed.inboundLotId), event_type_code: 'ALLOCATION_EDITED' } });
    expect(event).toMatchObject({ actor_user_id: ids.user, summary: {
      before: [{ purchaseOrderLineId: String(lineA), qty: '25' }],
      after: [{ purchaseOrderLineId: String(lineA), qty: '20' }, { purchaseOrderLineId: String(lineB), qty: '10' }],
    } });
    expect(await stockSnapshot(passed)).toEqual(before);

    const current = version + 1;
    const over = await put(allocationsPath(passed.inboundLotId)).send({ versionNo: current, allocations: [{ purchaseOrderLineId: Number(lineB), qty: 13 }] }).expect(400);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}/po-allocations', 'put', 400), over.body);
    expect(over.body.errors).toEqual([expect.objectContaining({ code: 'RANGE', field: 'allocations[0].qty' })]);
    expect(over.body.details).toEqual({ purchaseOrderLineId: Number(lineB), maxQty: 12 });
    const sum = await put(allocationsPath(passed.inboundLotId)).send({
      versionNo: current, allocations: [{ purchaseOrderLineId: Number(lineA), qty: 25 }, { purchaseOrderLineId: Number(lineB), qty: 12 }],
    }).expect(400);
    expect(sum.body.errors).toEqual([expect.objectContaining({ code: 'RANGE', field: 'allocations' })]);
    expect(sum.body.details).toMatchObject({ receivedQty: 30, allocatedQty: 37 });
    const stranger = await put(allocationsPath(passed.inboundLotId)).send({ versionNo: current, allocations: [{ purchaseOrderLineId: Number(foreign.lineIds[0]), qty: 1 }] }).expect(400);
    expect(stranger.body.errors).toEqual([expect.objectContaining({ code: 'INVALID', field: 'allocations[0].purchaseOrderLineId' })]);
    const twice = await put(allocationsPath(passed.inboundLotId)).send({
      versionNo: current, allocations: [{ purchaseOrderLineId: Number(lineA), qty: 1 }, { purchaseOrderLineId: Number(lineA), qty: 1 }],
    }).expect(400);
    expect(twice.body.errors).toEqual([expect.objectContaining({ code: 'INVALID', field: 'allocations[1].purchaseOrderLineId' })]);
    // 실패는 아무것도 바꾸지 않는다.
    expect([await receivedOf(lineA), await receivedOf(lineB), await versionOf(passed.inboundLotId)]).toEqual([20, 10, current]);

    // 배정을 비우면 전량 P/O 없음 — 받은 양이 모두 내려간다.
    const cleared = await put(allocationsPath(passed.inboundLotId)).send({ versionNo: current, allocations: [] }).expect(200);
    expect(cleared.body).toMatchObject({ poAllocations: [], unallocatedQty: 30 });
    expect([await receivedOf(lineA), await receivedOf(lineB)]).toEqual([0, 0]);
  });

  it('US8-3 RECEIVED 가 아니면 409 STATE_LOCKED · 이전 데이터 409 LEGACY_INBOUND_LOT · 판 번호가 다르면 409 VERSION_CONFLICT', async () => {
    const receiving = await issueAndReceive(fx, batch(ids.s9, 1, 5));
    const locked = await put(allocationsPath(receiving.inboundLot.inboundLotId))
      .send({ versionNo: await versionOf(receiving.inboundLot.inboundLotId), allocations: [] }).expect(409);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}/po-allocations', 'put', 409), locked.body);
    expect(locked.body.errors).toEqual([expect.objectContaining({ code: 'STATE_LOCKED' })]);
    const legacy = await makeLegacyLot(ids.s9, 5);
    const legacyResponse = await put(allocationsPath(legacy)).send({ versionNo: await versionOf(legacy), allocations: [] }).expect(409);
    expect(legacyResponse.body.errors).toEqual([expect.objectContaining({ code: 'LEGACY_INBOUND_LOT' })]);
    const stale = await put(allocationsPath(full.inboundLotId)).send({ versionNo: (await versionOf(full.inboundLotId)) - 1, allocations: [] }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
  });

  it('US8-4 :finalize — P/O 없음이 남으면 400 UNALLOCATED_REMAINS(details.unallocatedQty), 확인하면 FINALIZED·최종 마감 사람·시각·RECEIPT_FINALIZED, 두 번째 409, 앞뒤 ERP 아웃박스 변화 없음', async () => {
    const outboxBefore = await prisma.integration_message.count();
    const version = await versionOf(full.inboundLotId);
    const unacknowledged = await post(finalizePath(full.inboundLotId)).send({ versionNo: version }).expect(400);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:finalize', 'post', 400), unacknowledged.body);
    expect(unacknowledged.body.errors).toEqual([expect.objectContaining({ code: 'UNALLOCATED_REMAINS' })]);
    expect(unacknowledged.body.details).toEqual({ unallocatedQty: 10 });

    const response = await post(finalizePath(full.inboundLotId)).send({ versionNo: version, acknowledgeUnallocated: true }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:finalize', 'post', 200), response.body);
    expect(response.body).toMatchObject({
      statusCode: 'FINALIZED', versionNo: version + 1, finalizable: false, finalizeBlockers: [], finalizedByName: '작업기록 ALL',
    });
    const row = await inboundLotRow(full.inboundLotId);
    expect(row).toMatchObject({ status_code: 'FINALIZED', finalized_by: ids.user });
    expect(row.finalized_at).not.toBeNull();
    expect(response.body.finalizedAt).toBe(row.finalized_at?.toISOString());
    const event = await prisma.inbound_lot_event.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id, event_type_code: 'RECEIPT_FINALIZED' } });
    expect(event).toMatchObject({ actor_user_id: ids.user, summary: expect.objectContaining({ unallocatedQty: '10', acknowledgeUnallocated: true }) });
    expect(await prisma.integration_message.count()).toBe(outboxBefore);

    const again = await post(finalizePath(full.inboundLotId)).send({ versionNo: version + 1, acknowledgeUnallocated: true }).expect(409);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:finalize', 'post', 409), again.body);
    expect(again.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    const listed = await get(`${LOTS}?plantId=${String(ids.plant)}&statusCode=FINALIZED&erpSendModeCode=ON_FINALIZE`).expect(200);
    expect((listed.body.items as Row[]).map((item) => item.inboundLotId)).toEqual([full.inboundLotId]);
  });

  it('US8-4 마감 승인 대기가 아니면 409 blockers[]·errors[].code — 상태는 그대로', async () => {
    const waiting = await passedLot(ids.s10, 2, 5);
    const version = await versionOf(waiting.inboundLotId);
    const response = await post(finalizePath(waiting.inboundLotId)).send({ versionNo: version, acknowledgeUnallocated: true }).expect(409);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:finalize', 'post', 409), response.body);
    const lotNos = waiting.lots.map((lot) => lot.lotNo).sort();
    expect(response.body.blockers).toEqual([{ code: 'NOT_RECEIVED', lotNos }]);
    expect(response.body.errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'NOT_RECEIVED', lotNos })]);
    expect(await inboundLotRow(waiting.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', version_no: version, finalized_at: null });
  });

  it('US8-5 SC-011 최종 마감 뒤 입고 취소 요청·실행, :reopen-receipt, PUT po-allocations, :split-lots, :cancel-confirm 모두 409 INBOUND_LOT_FINALIZED — 출고·이동은 된다', async () => {
    const id = full.inboundLotId;
    const receipt = await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: BigInt(full.goodsReceiptId) } });
    const cancelPath = `/api/logistics/document-progress/GOODS_RECEIPT/${String(full.goodsReceiptId)}`;
    const requested = await request(app.getHttpServer()).post(`${cancelPath}:request-cancel`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', String(receipt.version_no)).send({ reason: '최종 마감 뒤 취소 시도' }).expect(409);
    expect(requested.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    expect((await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: receipt.goods_receipt_id } })).status_code).toBe('POSTED');
    // 실행 — 최종 마감 전에 올라간 취소 요청이 남아 있던 경우(직접 세움).
    await prisma.goods_receipt.update({ where: { goods_receipt_id: receipt.goods_receipt_id }, data: { status_code: 'CANCEL_REQUESTED' } });
    const executed = await request(app.getHttpServer()).post(`${cancelPath}:cancel`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', String(receipt.version_no)).send({}).expect(409);
    expect(executed.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    await prisma.goods_receipt.update({ where: { goods_receipt_id: receipt.goods_receipt_id }, data: { status_code: 'POSTED' } });
    const progress = await get(cancelPath).expect(200);
    expect(progress.body.progress).toMatchObject({ cancellable: false, cancelBlockedReasonCode: 'INBOUND_LOT_FINALIZED' });

    const reopened = await post(`${LOTS}/${String(id)}:reopen-receipt`).send({ versionNo: await versionOf(id) }).expect(409);
    expect((reopened.body.errors as { code: string }[]).map((error) => error.code)).toEqual(['INBOUND_LOT_FINALIZED']);
    const edited = await put(allocationsPath(id)).send({ versionNo: await versionOf(id), allocations: [] }).expect(409);
    expect(edited.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    expect(await receivedOf(fullOrderLine)).toBe(20);
    // 분리·선별이 함께 쓰는 코어(splitInboundLot)가 막는다 — 선별은 열린 부적합이 있으면 최종 마감이 안 되므로 분리로 본다.
    const split = await post(`${LOTS}/${String(id)}:split-lots`).send({ versionNo: await versionOf(id), lotIds: [full.lots[0].lotId] }).expect(409);
    expect(split.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    const preview = await get(`${LOTS}/${String(id)}/split-preview?lotIds=${String(full.lots[0].lotId)}`).expect(409);
    expect(preview.body.errors).toEqual([expect.objectContaining({ code: 'INBOUND_LOT_FINALIZED' })]);
    expect(await prisma.lot.count({ where: { inbound_lot_id: BigInt(id) } })).toBe(full.lots.length);
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot_id: BigInt(id), status_code: { not: 'CANCELLED' } } });
    const cancelled = await post(`/api/quality/inspection-requests/${String(iqc.inspection_request_id)}:cancel-confirm`)
      .send({ versionNo: iqc.version_no }).expect(409);
    expect((cancelled.body.errors as { code: string; lotNos: string[] }[])[0]).toMatchObject({
      code: 'INBOUND_LOT_FINALIZED', lotNos: full.lots.map((lot) => lot.lotNo).sort(),
    });
    expect((await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: iqc.inspection_request_id } })).status_code).toBe('COMPLETED');

    // 입고 뒤 재고 업무는 막지 않는다.
    await post('/api/logistics/location-moves').send({
      warehouseId: Number(ids.warehouse), businessDate: DAY, occurredAt: `${DAY}T08:00:00.000Z`,
      lines: [{ lotId: full.lots[0].lotId, fromLocationId: Number(ids.location), toLocationId: Number(ids.location2),
        qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', qty: 2 }],
    }).expect(201);
    await post('/api/logistics/goods-issues').send({
      issueTypeCode: 'OTHER', sourceDocumentTypeCode: 'GOODS_RECEIPT', sourceDocumentId: full.goodsReceiptId, sourceWarehouseId: Number(ids.warehouse),
      issuedAt: `${DAY}T09:00:00.000Z`, businessDate: DAY, occurredAt: `${DAY}T09:00:00.000Z`,
      lines: [{ itemId: Number(ids.item), lotId: full.lots[1].lotId, issueQty: 1, uomId: Number(ids.ea), sourceLocationId: Number(ids.location) }],
    }).expect(201);
    expect((await inboundLotRow(id)).status_code).toBe('FINALIZED');
  });

  it('R23-1 두 관리자 동시 배정 수정·배정 수정과 최종 마감 동시 → 먼저 끝난 것만, 뒤는 409 VERSION_CONFLICT', async () => {
    const order = await makeOrder(ids.s11, '2026-11-01', [{ ordered: 5 }, { ordered: 5 }]);
    const passed = await passedLot(ids.s11, 1, 10);
    await receiveGoods(passed.lots);
    const version = await versionOf(passed.inboundLotId);
    const edits = await Promise.all([
      put(allocationsPath(passed.inboundLotId)).send({ versionNo: version, allocations: [{ purchaseOrderLineId: Number(order.lineIds[0]), qty: 1 }] }),
      put(allocationsPath(passed.inboundLotId)).send({ versionNo: version, allocations: [{ purchaseOrderLineId: Number(order.lineIds[1]), qty: 2 }] }),
    ]);
    expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(edits.find((response) => response.status === 409)?.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    // 이긴 쪽 배정만 남는다 — 라인 0 에 1 이거나 라인 1 에 2.
    expect(await receivedOf(order.lineIds[0]) + await receivedOf(order.lineIds[1])).toBe(edits[0].status === 200 ? 1 : 2);

    const next = version + 1;
    const raced = await Promise.all([
      put(allocationsPath(passed.inboundLotId)).send({ versionNo: next, allocations: [] }),
      post(finalizePath(passed.inboundLotId)).send({ versionNo: next, acknowledgeUnallocated: true }),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(raced.find((response) => response.status === 409)?.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await versionOf(passed.inboundLotId)).toBe(next + 1);
  });

  it('이전 데이터(PER_RECEIPT) :finalize·:reopen-receipt 409 LEGACY_INBOUND_LOT', async () => {
    const legacy = await makeLegacyLot(ids.s12, 5);
    const finalized = await post(finalizePath(legacy)).send({ versionNo: await versionOf(legacy), acknowledgeUnallocated: true }).expect(409);
    expect(finalized.body.errors).toEqual([expect.objectContaining({ code: 'LEGACY_INBOUND_LOT' })]);
    const reopened = await post(`${LOTS}/${String(legacy)}:reopen-receipt`).send({ versionNo: await versionOf(legacy) }).expect(409);
    expect((reopened.body.errors as { code: string }[]).map((error) => error.code)).toEqual(['LEGACY_INBOUND_LOT']);
    expect((await inboundLotRow(legacy)).status_code).toBe('RECEIVED');
  });

  it('R19-1 권한 — W-01-16 없으면 후보·배정 수정·최종 마감 403, 입하 LOT 조회 권한도 없으면 목록 403', async () => {
    const id = full.inboundLotId;
    await request(app.getHttpServer()).get(candidatesPath(id)).set('Cookie', viewerCookie).expect(403);
    await request(app.getHttpServer()).put(allocationsPath(id)).set('Cookie', viewerCookie).send({ versionNo: 1, allocations: [] }).expect(403);
    await request(app.getHttpServer()).post(finalizePath(id)).set('Cookie', viewerCookie).set('Idempotency-Key', idempotencyKey(fx))
      .send({ versionNo: 1 }).expect(403);
    await request(app.getHttpServer()).get(`${LOTS}?plantId=${String(ids.plant)}`).set('Cookie', viewerCookie).expect(200);
    await request(app.getHttpServer()).get(`${LOTS}?plantId=${String(ids.plant)}&erpSendModeCode=ON_FINALIZE`).set('Cookie', outsiderCookie).expect(403);
  });

  it('한 달 치 목록(입하 LOT 90건·자재 관리 LOT 270개) — W-01-16 세 보기가 각각 2초 안', async () => {
    await makeMonthOfInboundLots(90, 3);
    const from = localDate(new Date(Date.now() - 30 * 24 * 3600 * 1000), TZ);
    const base = `${LOTS}?plantId=${String(ids.plant)}&erpSendModeCode=ON_FINALIZE&receivingDateFrom=${from}&receivingDateTo=${DAY}&size=200`;
    for (const view of ['&finalizable=true', '&statusCode=RECEIVING,RECEIVED&finalizable=false', '&statusCode=FINALIZED']) {
      const started = Date.now();
      const response = await get(`${base}${view}`).expect(200);
      expect(Date.now() - started).toBeLessThan(2000);
      expectShape(LIST, response.body);
    }
    const all = await get(base).expect(200);
    expect((all.body.page as { totalElements?: number; total?: number }).totalElements ?? all.body.items.length).toBeGreaterThanOrEqual(90);
  });

  it('R-5a·R-16 승인됐지만 실행 전인 IQC 생략 결재도 마감 취소가 무효로 만든다 — 다시 마감한 뒤 :skip-iqc 는 400 STATE_LOCKED, 검사는 그대로', async () => {
    const { inboundLot, lots } = await issueAndReceive(fx, batch(ids.s14, 2, 5));
    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const approval = await prisma.approval_request.create({
      data: {
        approval_request_no: `${PREFIX}-SKIP-${String(inboundLot.inboundLotId)}`, approval_type_code: 'IQC_SKIP', target_type_code: 'INBOUND_LOT',
        target_id: BigInt(inboundLot.inboundLotId), requested_by: ids.user, requested_at: new Date(), status_code: 'APPROVED', reason: '긴급 생산',
      },
    });
    await post(`${LOTS}/${String(inboundLot.inboundLotId)}:reopen-receipt`).send({ versionNo: await versionOf(inboundLot.inboundLotId) }).expect(200);
    const voided = await prisma.approval_request.findUniqueOrThrow({ where: { approval_request_id: approval.approval_request_id } });
    expect(voided).toMatchObject({ status_code: 'APPROVED', target_summary: expect.objectContaining({ voidedBy: 'RECEIPT_REOPENED' }) });

    await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const skipped = await post(`/api/trace/lots/${String(lots[0].lotId)}:skip-iqc`).send({}).expect(400);
    expect(skipped.body.errors).toEqual([expect.objectContaining({ code: 'STATE_LOCKED', message: expect.stringContaining('무효') })]);
    const current = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId), status_code: { not: 'CANCELLED' } } });
    expect(current.status_code).toBe('REQUESTED');
    const statuses = await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(inboundLot.inboundLotId) }, select: { status_code: true } });
    expect(statuses.map((row) => row.status_code)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  function batch(supplier: bigint, lotCount: number, lotQty: number): Parameters<typeof issueAndReceive>[1] {
    return { plantId: Number(ids.plant), supplierId: Number(supplier), itemId: Number(ids.item), lotQty, lotCount };
  }

  /** 발행 → 받기 → 마감 → IQC 합격 — 자재 관리 LOT 전부 정상, 입하 LOT RECEIVED. */
  async function passedLot(supplier: bigint, lotCount: number, lotQty: number): Promise<Passed> {
    const { inboundLot } = await issueAndReceive(fx, batch(supplier, lotCount, lotQty));
    const lots = await passInboundLotIqc(fx, inboundLot.inboundLotId);
    return { inboundLotId: inboundLot.inboundLotId, lots };
  }

  /** 입고 API 로 LOT 들을 한 입고에 받는다. */
  async function receiveGoods(lots: IssuedMaterialLot[]): Promise<number> {
    const rows = await prisma.lot.findMany({ where: { lot_id: { in: lots.map((lot) => BigInt(lot.lotId)) } }, select: { lot_id: true, inbound_lot: { select: { inbound_receipt_line_id: true } } } });
    const lineOf = new Map(rows.map((row) => [Number(row.lot_id), row.inbound_lot?.inbound_receipt_line_id]));
    const response = await post('/api/logistics/goods-receipts').send({
      receiptTypeCode: 'MATERIAL', plantId: Number(ids.plant), warehouseId: Number(ids.warehouse), receiptDatetime: `${DAY}T07:00:00.000Z`, businessDate: DAY,
      lines: lots.map((lot) => ({
        inboundReceiptLineId: Number(lineOf.get(lot.lotId)), itemId: Number(ids.item), lotId: lot.lotId, receiptQty: lot.lotQty, uomId: Number(ids.ea),
        qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(ids.location),
      })),
    }).expect(201);
    return (response.body as { goodsReceipt: { goodsReceiptId: number } }).goodsReceipt.goodsReceiptId;
  }

  /** 열린 부적합(판정 대기)에 담긴 LOT — 처분 진행 중. */
  async function openNonconformance(lot: IssuedMaterialLot): Promise<void> {
    seq += 1;
    const nc = await prisma.nonconformance.create({
      data: { nonconformance_no: `${PREFIX}-NC-${String(seq)}`, item_id: ids.item, severity_code: 'MAJOR', description: '처분 진행', status_code: 'PENDING_DECISION', opened_at: new Date() },
    });
    await prisma.nonconformance_lot.create({
      data: { nonconformance_id: nc.nonconformance_id, lot_id: BigInt(lot.lotId), affected_qty: lot.lotQty, uom_id: ids.ea,
        quality_status_before_code: 'NORMAL', quality_status_after_code: 'DEFECTIVE' },
    });
  }

  /** 공급사 반품 출고(전기됨) — 그 LOT 이 반품으로 끝났다. */
  async function supplierReturn(lot: IssuedMaterialLot): Promise<void> {
    seq += 1;
    const issue = await prisma.goods_issue.create({
      data: { goods_issue_no: `${PREFIX}-GI-${String(seq)}`, issue_type_code: 'SUPPLIER_RETURN', source_document_type_code: 'INBOUND_RECEIPT',
        source_document_id: 0n, source_warehouse_id: ids.warehouse, issued_at: new Date(), status_code: 'POSTED' },
    });
    await prisma.goods_issue_line.create({
      data: { goods_issue_id: issue.goods_issue_id, line_no: 1, item_id: ids.item, lot_id: BigInt(lot.lotId), issue_qty: lot.lotQty, uom_id: ids.ea, source_location_id: ids.location },
    });
  }

  /** 재고·LOT·입고 — 배정 수정 앞뒤로 같아야 한다. */
  async function stockSnapshot(passed: Passed): Promise<unknown> {
    const lotIds = passed.lots.map((lot) => BigInt(lot.lotId));
    const [balances, lots, receipts, ledger] = await Promise.all([
      prisma.inventory_balance.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, location_id: true, on_hand_qty: true }, orderBy: [{ lot_id: 'asc' }, { location_id: 'asc' }] }),
      prisma.lot.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, status_code: true, initial_qty: true, version_no: true, inbound_lot_id: true }, orderBy: { lot_id: 'asc' } }),
      prisma.goods_receipt_line.findMany({ where: { lot_id: { in: lotIds } }, select: { goods_receipt_line_id: true, receipt_qty: true, goods_receipt: { select: { status_code: true } } } }),
      prisma.inventory_transaction_line.count({ where: { lot_id: { in: lotIds } } }),
    ]);
    return JSON.parse(JSON.stringify({ balances, lots, receipts, ledger }, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))) as unknown;
  }

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function put(path: string): request.Test {
    return request(app.getHttpServer()).put(path).set('Cookie', cookie);
  }

  function post(path: string): request.Test {
    return request(app.getHttpServer()).post(path).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx));
  }

  async function versionOf(inboundLotId: number): Promise<number> {
    return (await inboundLotRow(inboundLotId)).version_no;
  }

  function inboundLotRow(inboundLotId: number) {
    return prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } });
  }

  async function receivedOf(lineId: bigint): Promise<number> {
    return Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: lineId } })).received_qty);
  }

  async function makeOrder(supplier: bigint, orderDate: string, lines: { ordered: number; tolerance?: number }[]): Promise<{ lineIds: bigint[] }> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${String(seq)}`, erp_purchase_order_no: `${PREFIX}-ERP-${String(seq)}`, supplier_id: supplier, business_unit_id: ids.unit,
        plant_id: ids.plant, order_date: new Date(`${orderDate}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    const lineIds: bigint[] = [];
    for (const [index, line] of lines.entries()) {
      lineIds.push((await prisma.purchase_order_line.create({
        data: { purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: ids.item, uom_id: ids.ea, ordered_qty: line.ordered, tolerance_over_qty: line.tolerance ?? 0 },
      })).purchase_order_line_id);
    }
    return { lineIds };
  }

  /** 이전 데이터 입하 LOT — PER_RECEIPT·RECEIVED, 줄에 LOT 하나(데이터 이전 1). */
  async function makeLegacyLot(supplier: bigint, qty: number): Promise<number> {
    seq += 1;
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-${String(seq)}`, supplier_id: supplier, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: header.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    const inboundLot = await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: supplier, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: new Date(),
        erp_send_mode_code: 'PER_RECEIPT', inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    return Number(inboundLot.inbound_lot_id);
  }

  /** 한 달(30일)에 걸친 새 흐름 입하 LOT — 셋 중 하나는 입고까지 끝난 것처럼 보이지 않게 정상 LOT 만(마감 승인 대기 판정 재료). */
  async function makeMonthOfInboundLots(count: number, lotsPer: number): Promise<void> {
    const header = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-MONTH`, supplier_id: ids.s13, plant_id: ids.plant, receipt_datetime: new Date(), status_code: 'REGISTERED' },
    });
    for (let index = 0; index < count; index += 1) {
      const day = localDate(new Date(Date.now() - (index % 30) * 24 * 3600 * 1000), TZ);
      const line = await prisma.inbound_receipt_line.create({
        data: { inbound_receipt_id: header.inbound_receipt_id, line_no: index + 1, item_id: ids.item, received_qty: lotsPer * 10, uom_id: ids.ea,
          supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
      });
      const inboundLot = await prisma.inbound_lot.create({
        data: { inbound_lot_no: `${PREFIX}-IL-${String(index)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: ids.s13, uom_id: ids.ea,
          status_code: 'RECEIVED', receiving_date: new Date(`${day}T00:00:00.000Z`), received_closed_at: new Date(),
          erp_send_mode_code: 'ON_FINALIZE', inbound_receipt_line_id: line.inbound_receipt_line_id },
      });
      await prisma.lot.createMany({
        data: Array.from({ length: lotsPer }, (_unused, lot) => ({
          lot_no: `${PREFIX}-ML-${String(index)}-${String(lot)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 10, uom_id: ids.ea,
          source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'NORMAL', inbound_lot_id: inboundLot.inbound_lot_id,
        })),
      });
    }
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
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '작업기록법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '작업기록사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '작업기록공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '작업기록자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    for (let index = 1; index <= 14; index += 1) {
      ids[`s${String(index)}`] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S${String(index)}`, partner_name: `${PREFIX} 공급사 ${String(index)}` } })).partner_id;
    }
    ids.worker = (await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '작업기록작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '작업기록창고',
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.location = (await prisma.location.create({ data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L1`, location_name: '작업기록위치1' } })).location_id;
    ids.location2 = (await prisma.location.create({ data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L2`, location_name: '작업기록위치2' } })).location_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `작업기록 ${suffix}`, status_code: 'EMPLOYED' } });
    ids.user ??= user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `작업기록 ${suffix}` } });
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
    const goodsReceipts = `SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants})`;
    const warehouses = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`;
    const issues = `SELECT goods_issue_id FROM logistics.goods_issue WHERE source_warehouse_id IN (${warehouses})`;
    const transfers = `SELECT stock_transfer_id FROM logistics.stock_transfer WHERE from_warehouse_id IN (${warehouses})`;
    const nonconformances = `SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (${items})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))
         OR (aggregate_type_code = 'GOODS_RECEIPT' AND aggregate_id IN (${goodsReceipts}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.document_cancellation WHERE document_id IN (${goodsReceipts}) AND document_type_code = 'GOODS_RECEIPT'`,
      `DELETE FROM app.approval_request WHERE approval_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.stock_transfer_line WHERE stock_transfer_id IN (${transfers})`,
      `DELETE FROM logistics.stock_transfer WHERE stock_transfer_id IN (${transfers})`,
      `DELETE FROM logistics.goods_issue_line WHERE goods_issue_id IN (${issues})`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_id IN (${issues})`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${nonconformances})`,
      `DELETE FROM quality.nonconformance WHERE nonconformance_id IN (${nonconformances})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.lot_four_m_change WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.item_inspection_level_history WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
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
