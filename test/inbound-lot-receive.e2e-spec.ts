/**
 * 피처 005 S4 — PDA 입하 받기·해제·공급사 LOT·입하 LOT 조회·줄 수량 잠금(omf-all-around#254 · T035).
 * 받기는 MOBILE 단말(M-01-01) + 작업자, 발행 묶음은 POP 단말(P-01-01)로 만든다. 스캔 하나 = `:receive` 하나.
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
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InboundLotFixture, ReceivedInboundLot, idempotencyKey, issueMaterialLots, receiveBody, receiveScan, receiveScans,
  sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E5IL';
const DAY = '2026-11-12';
const WORKER_NO = `${PREFIX}-W1`;
const RECEIVE = '/api/logistics/inbound-lots:receive';
const LOTS = '/api/logistics/inbound-lots';
const unregisterPath = (id: number): string => `${LOTS}/${String(id)}:unregister-lots`;
const supplierLotPath = (id: number): string => `${LOTS}/${String(id)}/lots/supplier-lot-no`;

const CONTRACT = JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(CONTRACT, 'contract');
const schemaOf = (path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `contract#/paths/${path.replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
const schemaRef = (name: string): ValidateFunction => ajv.compile({ $ref: `contract#/components/schemas/${name}` });

function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

describe('피처 005 S4 — PDA 입하 받기·해제·공급사 LOT (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let narrowCookie: string;
  let closerCookie: string;
  let mobileToken: string;
  let mobileToken2: string;
  let popToken: string;
  let foreignMobileToken: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let terminalSeq = 0;
  /** US2-1 이 연 (S, A) 입하 LOT — 뒤 시험이 이어 쓴다. */
  let saLot: ReceivedInboundLot;
  let saLotIds: number[] = [];

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
    closerCookie = await makeUser('CLOSER', ['M-01-03']);
    mobileToken = await terminalToken(ids.plant, 'MOBILE');
    mobileToken2 = await terminalToken(ids.plant, 'MOBILE');
    popToken = await terminalToken(ids.plant, 'POP');
    foreignMobileToken = await terminalToken(ids.foreignPlant, 'MOBILE');
    fx = { app, issuer: terminalAuth(popToken, WORKER_NO), receiver: terminalAuth(mobileToken, WORKER_NO), businessDate: DAY, keys };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const batch = (supplier: bigint, item: bigint, lotCount: number, lotQty = 1000): Parameters<typeof issueMaterialLots>[1] => ({
    plantId: Number(ids.plant), supplierId: Number(supplier), itemId: Number(item), lotQty, lotCount,
  });

  it('US2-1 첫 스캔이 새 입하 LOT(RECEIVING)을 열고 다음 둘은 붙는다 — 줄 3,000·검사 대기·보류·P/O 배정 없음·IQC 요청 없음', async () => {
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 3));
    const first = await mobilePost(RECEIVE).send(receiveBody(fx, [{ lotId: lots[0].lotId }])).expect(201);
    expectShape(schemaOf('/logistics/inbound-lots:receive', 'post', 201), first.body);
    const [opened] = (first.body as { inboundLots: ReceivedInboundLot[] }).inboundLots;
    expect(opened).toMatchObject({ created: true, autoClosedInboundLotNo: null, receivedQty: 1000, lotCount: 1 });
    expect(opened.inboundLotNo).toMatch(/^IL-20261112-\d{4}$/);
    expect(opened.lots).toEqual([{ lotId: lots[0].lotId, lotNo: lots[0].lotNo, lotQty: 1000, statusCode: 'INSPECTION_PENDING', fromSupplierLabel: false }]);

    const next = await receiveScans(fx, [lots[1].lotId, lots[2].lotId]);
    expect(next.map((row) => [row.inboundLotId, row.created, row.lotCount])).toEqual([
      [opened.inboundLotId, false, 2], [opened.inboundLotId, false, 3],
    ]);
    saLot = next[1];
    saLotIds = lots.map((lot) => lot.lotId);
    expect(saLot.receivedQty).toBe(3000);

    const inbound = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(opened.inboundLotId) }, include: { inbound_receipt_line: true } });
    expect(inbound).toMatchObject({ status_code: 'RECEIVING', erp_send_mode_code: 'ON_FINALIZE', supplier_id: ids.supplierS, item_id: ids.itemA });
    expect(inbound.receiving_date.toISOString().slice(0, 10)).toBe(DAY);
    expect(inbound.open_since_date?.toISOString().slice(0, 10)).toBe(DAY);
    expect(Number(inbound.inbound_receipt_line.received_qty)).toBe(3000);
    expect(inbound.inbound_receipt_line.lot_id).toBeNull();
    const rows = await prisma.lot.findMany({ where: { lot_id: { in: saLotIds.map(BigInt) } }, include: { lot_hold: true } });
    for (const row of rows) {
      expect(row).toMatchObject({
        lifecycle_status_code: 'ACTIVE', status_code: 'INSPECTION_PENDING', inbound_lot_id: inbound.inbound_lot_id,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: inbound.inbound_receipt_line_id,
      });
      expect(row.lot_hold.filter((hold) => hold.released_at === null).map((hold) => hold.reason_code)).toEqual(['INCOMING_INSPECTION_WAIT']);
    }
    expect(await prisma.lot_lifecycle_history.count({ where: { lot_id: { in: rows.map((row) => row.lot_id) }, transition_code: 'L4' } })).toBe(3);
    expect(await prisma.inbound_receipt_po_allocation.count({ where: { inbound_receipt_line_id: inbound.inbound_receipt_line_id } })).toBe(0);
    expect(await prisma.inspection_request.count({
      where: { OR: [{ inbound_lot_id: inbound.inbound_lot_id }, { lot_id: { in: rows.map((row) => row.lot_id) } }] },
    })).toBe(0);

    const detail = await get(`${LOTS}/${String(opened.inboundLotId)}`).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}', 'get', 200), detail.body);
    expect(detail.body).toMatchObject({
      statusCode: 'RECEIVING', lotCount: 3, receivedQty: 3000, goodsReceivedQty: 0, unallocatedQty: 3000, iqc: null,
      inspectionRequired: true, reopenable: false, reopened: false, finalizable: false, reopenReasonCode: null,
      supplierCode: `${PREFIX}-S`, itemCode: `${PREFIX}-A`, uomCode: 'EA',
    });
    expect(detail.body.inboundReceiptNo).toMatch(/^IR-/);
    expect((detail.body.lots as { fromSupplierLabel: boolean; registeredAt: string }[]).every((lot) => !lot.fromSupplierLabel && lot.registeredAt)).toBe(true);
    expect((detail.body.events as { eventCode: string; actorName: string }[]).map((event) => event.eventCode)).toEqual([
      'CREATED_BY_RECEIVE', 'LOTS_REGISTERED', 'LOTS_REGISTERED', 'LOTS_REGISTERED',
    ]);
    expect(detail.body.events[0].actorName).toBe('받기작업자');
  });

  it('US2-9 같은 날 나중 스캔도 같은 입하 LOT 에 붙는다 — (공장, 공급사, 품목)마다 입하 중은 하나', async () => {
    const { lots } = await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 1));
    const later = await receiveScan(fx, { lotId: lots[0].lotId });
    expect(later).toMatchObject({ inboundLotId: saLot.inboundLotId, created: false, lotCount: 4, receivedQty: 4000 });
    saLotIds.push(lots[0].lotId);

    const list = await get(`${LOTS}?plantId=${String(ids.plant)}&supplierId=${String(ids.supplierS)}&itemId=${String(ids.itemA)}&statusCode=RECEIVING`).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots', 'get', 200), list.body);
    expect((list.body.items as { inboundLotId: number }[]).map((row) => row.inboundLotId)).toEqual([saLot.inboundLotId]);
    expect(list.body.items[0].firstRegisteredAt).not.toBeNull();
  });

  it('US2-4 T·A·T·B 섞어 스캔하면 입하 LOT 둘에 각각 붙고, 한 요청에 둘을 실어도 입하 LOT 별로 나뉜다', async () => {
    const a = (await issueMaterialLots(fx, batch(ids.supplierT, ids.itemA, 3))).lots;
    const b = (await issueMaterialLots(fx, batch(ids.supplierT, ids.itemB, 3, 200))).lots;
    const results = await receiveScans(fx, [a[0].lotId, b[0].lotId, a[1].lotId, b[1].lotId]);
    expect(results.map((row) => row.created)).toEqual([true, true, false, false]);
    expect(results[2].inboundLotId).toBe(results[0].inboundLotId);
    expect(results[3].inboundLotId).toBe(results[1].inboundLotId);
    expect(results[0].inboundLotId).not.toBe(results[1].inboundLotId);

    const both = await mobilePost(RECEIVE).send(receiveBody(fx, [{ lotId: b[2].lotId }, { lotId: a[2].lotId }])).expect(201);
    const received = both.body.inboundLots as ReceivedInboundLot[];
    expect(received.map((row) => [row.inboundLotId, row.lotCount, row.lots.map((lot) => lot.lotId)])).toEqual([
      [results[1].inboundLotId, 3, [b[2].lotId]], [results[0].inboundLotId, 3, [a[2].lotId]],
    ]);
  });

  it('US2-5 이미 등록·폐기된 LOT 을 다시 스캔하면 409 STATE_LOCKED·까닭 표지 — 같은 요청의 대기 LOT 도 등록되지 않는다', async () => {
    const waiting = (await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 2))).lots;
    await popPost('/api/trace/lots:void').send({ lotIds: [waiting[1].lotId] }).expect(200);

    const again = await mobilePost(RECEIVE).send(receiveBody(fx, [{ lotId: waiting[0].lotId }, { lotId: saLotIds[0] }, { lotId: waiting[1].lotId }])).expect(409);
    expectShape(schemaRef('InboundLotReceiveRejection'), again.body);
    expect(again.body.errors.map((error: { field: string; code: string }) => [error.field, error.code])).toEqual([
      ['lots.1', 'STATE_LOCKED'], ['lots.2', 'STATE_LOCKED'],
    ]);
    expect(again.body.rejectedLots.map((lot: { index: number; reasonCode: string }) => [lot.index, lot.reasonCode])).toEqual([
      [1, 'ALREADY_RECEIVED'], [2, 'VOIDED'],
    ]);
    const untouched = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(waiting[0].lotId) } });
    expect(untouched).toMatchObject({ lifecycle_status_code: 'WAITING', inbound_lot_id: null, source_type_code: 'MATERIAL_LOT_BATCH' });
    const line = await lineOf(saLot.inboundLotId);
    expect(Number(line.received_qty)).toBe(4000);
  });

  it('US2-6 사전부착 라벨 — 시스템에 없는 번호는 즉석 생성(바로 ACTIVE·라벨의 공급사 LOT)·형식/MES 에 없는 코드 400·있는 번호는 그 LOT 으로', async () => {
    const label = `${PREFIX}-A|500|261112|${PREFIX}-S|0901`;
    const created = await receiveScan(fx, { lotNo: label, supplierLotNo: '  SUP-LBL-1 ' });
    expect(created).toMatchObject({ inboundLotId: saLot.inboundLotId, created: false, lotCount: 5, receivedQty: 4500 });
    expect(created.lots).toEqual([expect.objectContaining({ lotNo: label, lotQty: 500, statusCode: 'INSPECTION_PENDING', fromSupplierLabel: true })]);
    const row = await prisma.lot.findUniqueOrThrow({
      where: { lot_id: BigInt(created.lots[0].lotId) }, include: { lot_external_identifier: true, lot_hold: true },
    });
    expect(row).toMatchObject({ lifecycle_status_code: 'ACTIVE', item_id: ids.itemA, uom_id: ids.ea, inbound_lot_id: BigInt(saLot.inboundLotId) });
    expect(row.lot_external_identifier.map((identifier) => [identifier.identifier_type_code, identifier.external_identifier, identifier.partner_id]))
      .toEqual([['SUPPLIER_LOT', 'SUP-LBL-1', ids.supplierS]]);
    expect(row.lot_hold.filter((hold) => hold.released_at === null)).toHaveLength(1);
    saLotIds.push(created.lots[0].lotId);

    for (const [lotNo, field] of [
      ['NOT-A-LABEL', 'lots.0.lotNo'],
      [`${PREFIX}-ZZ|500|261112|${PREFIX}-S|0001`, 'lots.0.lotNo'],
      [`${PREFIX}-A|500|261112|${PREFIX}-ZZ|0001`, 'lots.0.lotNo'],
    ] as const) {
      const rejected = await mobilePost(RECEIVE).send(receiveBody(fx, [{ lotNo }])).expect(400);
      expect(rejected.body.errors).toEqual([expect.objectContaining({ field, code: 'INVALID' })]);
    }
    const twice = await mobilePost(RECEIVE).send(receiveBody(fx, [{ lotNo: `${PREFIX}-A|500|261112|${PREFIX}-S|0902` }, { lotNo: `${PREFIX}-A|500|261112|${PREFIX}-S|0902` }])).expect(400);
    expect(twice.body.errors[0]).toMatchObject({ field: 'lots.1', code: 'INVALID' });
    expect(await prisma.lot.count({ where: { lot_no: `${PREFIX}-A|500|261112|${PREFIX}-S|0902` } })).toBe(0);

    // 시스템에 있는 번호(미리 만든 대기 LOT 의 라벨)면 그 LOT 으로 받는다 — 계정(M-01-01) 세션은 공장을 본문으로 준다.
    const existing = (await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 1))).lots[0];
    const byNo = await webPost(RECEIVE).send(receiveBody(fx, [{ lotNo: existing.lotNo }], { plantId: Number(ids.plant) })).expect(201);
    expect(byNo.body.inboundLots[0]).toMatchObject({ inboundLotId: saLot.inboundLotId, lotCount: 6 });
    expect(byNo.body.inboundLots[0].lots).toEqual([expect.objectContaining({ lotId: existing.lotId, fromSupplierLabel: false })]);
    saLotIds.push(existing.lotId);
    expect(await prisma.lot.count({ where: { lot_no: existing.lotNo } })).toBe(1);
  });

  it('US2-6 공급사 LOT 번호 PATCH — 넣기·바꾸기·나머지에도(N:1)·null/빈 값 지움·앞뒤 공백·100자 RANGE·다른 입하 LOT 의 LOT INVALID·이벤트', async () => {
    const [one, two, three] = saLotIds;
    const set = await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [one], supplierLotNo: 'SL-1' }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}/lots/supplier-lot-no', 'patch', 200), set.body);
    expect(set.body.lots).toEqual([{ lotId: one, lotNo: expect.any(String), supplierLotNo: 'SL-1' }]);
    await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [one], supplierLotNo: 'SL-2' }).expect(200);
    expect(await supplierLotOf(one)).toEqual(['SL-2']);

    await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [one, two, three], supplierLotNo: '  SL-ALL  ' }).expect(200);
    for (const lotId of [one, two, three]) expect(await supplierLotOf(lotId)).toEqual(['SL-ALL']);
    await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [two], supplierLotNo: null }).expect(200);
    await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [three], supplierLotNo: '' }).expect(200);
    expect([await supplierLotOf(two), await supplierLotOf(three)]).toEqual([[], []]);

    const long = await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [one], supplierLotNo: 'X'.repeat(101) }).expect(400);
    expect(long.body.errors[0]).toMatchObject({ field: 'supplierLotNo', code: 'RANGE' });
    const foreignLot = (await prisma.lot.findFirstOrThrow({ where: { inbound_lot: { supplier_id: ids.supplierT } } })).lot_id;
    const other = await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [one, Number(foreignLot)], supplierLotNo: 'SL-X' }).expect(400);
    expect(other.body.errors[0]).toMatchObject({ field: 'lotIds', code: 'INVALID' });
    await mobilePatch(supplierLotPath(saLot.inboundLotId)).send({ lotIds: [], supplierLotNo: 'SL-X' }).expect(400);
    expect(await supplierLotOf(one)).toEqual(['SL-ALL']);

    const events = await prisma.inbound_lot_event.findMany({
      where: { inbound_lot_id: BigInt(saLot.inboundLotId), event_type_code: 'SUPPLIER_LOT_SET' }, orderBy: { inbound_lot_event_id: 'asc' },
    });
    expect(events.map((event) => event.summary)).toEqual(expect.arrayContaining([
      expect.objectContaining({ lotId: String(one), before: null, after: 'SL-1' }),
      expect.objectContaining({ lotId: String(one), before: 'SL-1', after: 'SL-2' }),
      expect.objectContaining({ lotId: String(two), before: 'SL-ALL', after: null }),
    ]));
    expect(events).toHaveLength(7);
  });

  it('US2-14 같은 Idempotency-Key 로 다시 보내면 첫 결과를 돌려주고 두 번 등록하지 않는다', async () => {
    const lot = (await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 1))).lots[0];
    const key = idempotencyKey(fx);
    const body = receiveBody(fx, [{ lotId: lot.lotId }]);
    const first = await mobilePost(RECEIVE, key).send(body).expect(201);
    const eventsBefore = await prisma.inbound_lot_event.count({ where: { inbound_lot_id: BigInt(saLot.inboundLotId) } });
    const replay = await mobilePost(RECEIVE, key).send(body).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(await prisma.inbound_lot_event.count({ where: { inbound_lot_id: BigInt(saLot.inboundLotId) } })).toBe(eventsBefore);
    expect(await prisma.lot_lifecycle_history.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(1);
    saLotIds.push(lot.lotId);
  });

  it('R20-1·SC-009 두 PDA 가 같은 공급사·품목을 동시에 처음 받으면 입하 LOT 하나에 둘 다 붙는다', async () => {
    const lots = (await issueMaterialLots(fx, batch(ids.supplierU, ids.itemA, 2))).lots;
    const [left, right] = await Promise.all([
      mobilePost(RECEIVE).send(receiveBody(fx, [{ lotId: lots[0].lotId }])),
      mobilePost(RECEIVE, idempotencyKey(fx), mobileToken2).send(receiveBody(fx, [{ lotId: lots[1].lotId }])),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    const results = [left.body.inboundLots[0], right.body.inboundLots[0]] as ReceivedInboundLot[];
    expect(results[0].inboundLotId).toBe(results[1].inboundLotId);
    expect(results.map((row) => row.created).sort()).toEqual([false, true]);
    expect(await prisma.inbound_lot.count({ where: { supplier_id: ids.supplierU, status_code: 'RECEIVING' } })).toBe(1);
    expect(await prisma.inbound_receipt.count({ where: { supplier_id: ids.supplierU } })).toBe(1);
    expect(Number((await lineOf(results[0].inboundLotId)).received_qty)).toBe(2000);
  });

  it('R5-1 검사 불필요 품목 LOT 해제 → 대기·검사 대기(C31·원천 해제) → 다시 받으면 활성·정상(C21) — 검사 필요 품목은 품질 그대로·보류만 닫힌다', async () => {
    const lots = (await issueMaterialLots(fx, batch(ids.supplierS, ids.itemN, 3, 50))).lots;
    const received = await receiveScans(fx, lots.map((lot) => lot.lotId));
    const inboundLotId = received[2].inboundLotId;
    expect(received.every((row) => row.lots[0].statusCode === 'NORMAL')).toBe(true);
    expect(await prisma.lot_status_event.count({ where: { lot_id: BigInt(lots[0].lotId), transition_code: 'C21' } })).toBe(1);

    const response = await mobilePost(unregisterPath(inboundLotId)).send({ lotIds: [lots[0].lotId], versionNo: await versionOf(inboundLotId) }).expect(200);
    expectShape(schemaOf('/logistics/inbound-lots/{inboundLotId}:unregister-lots', 'post', 200), response.body);
    expect(response.body).toMatchObject({ statusCode: 'RECEIVING', lotCount: 2, receivedQty: 100 });
    const batchRow = await prisma.material_lot_batch.findFirstOrThrow({ where: { item_id: ids.itemN }, orderBy: { material_lot_batch_id: 'desc' } });
    const back = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lots[0].lotId) } });
    expect(back).toMatchObject({
      lifecycle_status_code: 'WAITING', status_code: 'INSPECTION_PENDING', inbound_lot_id: null,
      source_type_code: 'MATERIAL_LOT_BATCH', source_id: batchRow.material_lot_batch_id,
    });
    const reset = await prisma.lot_status_event.findFirstOrThrow({ where: { lot_id: back.lot_id, transition_code: 'C31' } });
    expect(reset).toMatchObject({ previous_status_code: 'NORMAL', new_status_code: 'INSPECTION_PENDING',
      source_document_type_code: 'INBOUND_LOT', source_document_id: BigInt(inboundLotId), changed_worker_id: ids.worker });
    expect(await prisma.lot_lifecycle_history.count({ where: { lot_id: back.lot_id, transition_code: 'L6' } })).toBe(1);

    const again = await receiveScan(fx, { lotId: lots[0].lotId });
    expect(again).toMatchObject({ inboundLotId, lotCount: 3, receivedQty: 150 });
    expect(await prisma.lot.findUniqueOrThrow({ where: { lot_id: back.lot_id } })).toMatchObject({ lifecycle_status_code: 'ACTIVE', status_code: 'NORMAL' });
    expect(await prisma.lot_status_event.count({ where: { lot_id: back.lot_id, transition_code: 'C21' } })).toBe(2);

    // 검사 필요 품목(A) — 품질은 검사 대기 그대로, 열린 검사 대기 보류만 닫힌다(C31 없음).
    const inspected = saLotIds[1];
    await mobilePost(unregisterPath(saLot.inboundLotId)).send({ lotIds: [inspected], versionNo: await versionOf(saLot.inboundLotId) }).expect(200);
    const held = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(inspected) }, include: { lot_hold: true } });
    expect(held).toMatchObject({ lifecycle_status_code: 'WAITING', status_code: 'INSPECTION_PENDING', inbound_lot_id: null });
    expect(held.lot_hold.every((hold) => hold.released_at !== null)).toBe(true);
    expect(await prisma.lot_status_event.count({ where: { lot_id: held.lot_id, transition_code: 'C31' } })).toBe(0);
    saLotIds = saLotIds.filter((lotId) => lotId !== inspected);
  });

  it(':unregister-lots 마지막 LOT 해제 → 입하 줄·헤더 취소·입하 LOT VOIDED·이벤트 VOIDED, 다시 스캔하면 새 입하 LOT — 라벨로 만든 LOT 은 한 개짜리 묶음으로', async () => {
    const lot = (await issueMaterialLots(fx, batch(ids.supplierV, ids.itemB, 1, 10))).lots[0];
    const label = `${PREFIX}-B|10|261112|${PREFIX}-V|0901`;
    const first = await receiveScan(fx, { lotId: lot.lotId });
    const labelled = await receiveScan(fx, { lotNo: label, supplierLotNo: 'V-LBL' });
    const inboundLotId = first.inboundLotId;
    expect(labelled).toMatchObject({ inboundLotId, lotCount: 2 });

    const stale = await mobilePost(unregisterPath(inboundLotId)).send({ lotIds: [lot.lotId], versionNo: 1 }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });
    const notMine = await mobilePost(unregisterPath(inboundLotId)).send({ lotIds: [saLotIds[0]], versionNo: await versionOf(inboundLotId) }).expect(400);
    expect(notMine.body.errors[0]).toMatchObject({ field: 'lotIds', code: 'INVALID' });

    const voided = await mobilePost(unregisterPath(inboundLotId))
      .send({ lotIds: [lot.lotId, labelled.lots[0].lotId], versionNo: await versionOf(inboundLotId) }).expect(200);
    expect(voided.body).toMatchObject({ statusCode: 'VOIDED', lotCount: 0 });
    const row = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) }, include: { inbound_receipt_line: { include: { inbound_receipt: true } } } });
    expect(row.open_since_date).toBeNull();
    expect(row.inbound_receipt_line.status_code).toBe('CANCELLED');
    expect(row.inbound_receipt_line.inbound_receipt.status_code).toBe('CANCELLED');
    const events = await prisma.inbound_lot_event.findMany({ where: { inbound_lot_id: row.inbound_lot_id }, orderBy: { inbound_lot_event_id: 'asc' } });
    expect(events.map((event) => event.event_type_code).slice(-2)).toEqual(['LOTS_UNREGISTERED', 'VOIDED']);

    // 라벨 LOT 은 되돌릴 묶음이 없어 한 개짜리 묶음(단말 작업자 = POP)으로 대기에 돌아간다.
    const labelRow = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(labelled.lots[0].lotId) } });
    expect(labelRow).toMatchObject({ lifecycle_status_code: 'WAITING', source_type_code: 'MATERIAL_LOT_BATCH', inbound_lot_id: null });
    expect(await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: labelRow.source_id } })).toMatchObject({
      lot_count: 1, supplier_lot_no: 'V-LBL', created_channel_code: 'POP', created_worker_id: ids.worker, supplier_id: ids.supplierV,
    });

    await mobilePatch(supplierLotPath(inboundLotId)).send({ lotIds: [lot.lotId], supplierLotNo: 'X' }).expect(409);
    const locked = await mobilePost(unregisterPath(inboundLotId)).send({ lotIds: [lot.lotId], versionNo: await versionOf(inboundLotId) }).expect(409);
    expect(locked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

    const reopened = await receiveScan(fx, { lotNo: label });
    expect(reopened).toMatchObject({ created: true, lotCount: 1 });
    expect(reopened.inboundLotId).not.toBe(inboundLotId);
    expect(reopened.lots[0]).toMatchObject({ lotId: labelled.lots[0].lotId, fromSupplierLabel: false });
  });

  it('SC-003 입하 중 입하 LOT 마다 줄 수량 = 등록된 자재 관리 LOT 수량 합', async () => {
    const open = await prisma.inbound_lot.findMany({
      where: { plant_id: ids.plant, status_code: 'RECEIVING' }, include: { inbound_receipt_line: true, lot: true },
    });
    expect(open.length).toBeGreaterThanOrEqual(5);
    for (const row of open) {
      const sum = row.lot.reduce((total, lot) => total + Number(lot.initial_qty), 0);
      expect(Number(row.inbound_receipt_line.received_qty)).toBe(sum);
    }
  });

  it('R-5a 입하 LOT 에 속한 줄은 입하 수정(PUT …/lines)으로 수량을 바꾸거나 지울 수 없다 — 409 STATE_LOCKED', async () => {
    const line = await lineOf(saLot.inboundLotId);
    const receipt = await get(`/api/logistics/inbound-receipts/${String(line.inbound_receipt_id)}`).expect(200);
    const etag = String(receipt.headers.etag);
    const item = { inboundReceiptLineId: Number(line.inbound_receipt_line_id), itemId: Number(ids.itemA), uomId: Number(ids.ea), supplierLotMissing: false, supplierLotLabelAttached: false };
    const changed = await webPut(`/api/logistics/inbound-receipts/${String(line.inbound_receipt_id)}/lines`, etag)
      .send({ items: [{ ...item, receivedQty: Number(line.received_qty) + 1 }] }).expect(409);
    expect(changed.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    const removed = await webPut(`/api/logistics/inbound-receipts/${String(line.inbound_receipt_id)}/lines`, etag)
      .send({ items: [{ itemId: Number(ids.itemA), uomId: Number(ids.ea), receivedQty: 5, supplierLotMissing: false, supplierLotLabelAttached: false }] }).expect(409);
    expect(removed.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(Number((await lineOf(saLot.inboundLotId)).received_qty)).toBe(Number(line.received_qty));
  });

  it('R19-1 권한(M-01-01 · 해제는 M-01-03 도 · 조회는 W-01-01 도)·단말 MOBILE·X-Worker-No', async () => {
    const lot = (await issueMaterialLots(fx, batch(ids.supplierS, ids.itemA, 1))).lots[0];
    const body = receiveBody(fx, [{ lotId: lot.lotId }]);
    await sessionPost(RECEIVE, narrowCookie).send(body).expect(403);
    await sessionPost(RECEIVE, closerCookie).send(body).expect(403);
    await request(app.getHttpServer()).get(`${LOTS}?plantId=${String(ids.plant)}`).set('Cookie', narrowCookie).expect(200);
    await request(app.getHttpServer()).get(`${LOTS}/${String(saLot.inboundLotId)}`).set('Cookie', closerCookie).expect(200);
    await sessionPatch(supplierLotPath(saLot.inboundLotId), closerCookie).send({ lotIds: [saLotIds[0]], supplierLotNo: 'N' }).expect(403);
    await sessionPost(unregisterPath(saLot.inboundLotId), narrowCookie).send({ lotIds: [saLotIds[0]], versionNo: 1 }).expect(403);
    const closed = await sessionPost(unregisterPath(saLot.inboundLotId), closerCookie)
      .send({ lotIds: [saLotIds[0]], versionNo: await versionOf(saLot.inboundLotId) }).expect(200);
    expect(closed.body.lotCount).toBe(saLotIds.length - 1);
    saLotIds = saLotIds.slice(1);

    await request(app.getHttpServer()).post(RECEIVE).set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(401);
    await request(app.getHttpServer()).post(RECEIVE).set('Authorization', `Bearer ${popToken}`).set('X-Worker-No', WORKER_NO)
      .set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(401);
    await request(app.getHttpServer()).post(RECEIVE).set('Authorization', `Bearer ${mobileToken}`)
      .set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(401);
    await request(app.getHttpServer()).get(`${LOTS}/${String(saLot.inboundLotId)}`).set('Authorization', `Bearer ${foreignMobileToken}`).expect(401);
    await request(app.getHttpServer()).get(`${LOTS}?plantId=${String(ids.plant)}`).set('Authorization', `Bearer ${foreignMobileToken}`).expect(401);
    await mobilePost(RECEIVE, idempotencyKey(fx), foreignMobileToken).send(body).expect(401);
    expect(await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lot.lotId) } })).toMatchObject({ lifecycle_status_code: 'WAITING' });

    const own = await request(app.getHttpServer()).get(`${LOTS}?plantId=${String(ids.plant)}&statusCode=RECEIVING,VOIDED`)
      .set('Authorization', `Bearer ${mobileToken}`).expect(200);
    expect((own.body.items as { statusCode: string }[]).every((row) => ['RECEIVING', 'VOIDED'].includes(row.statusCode))).toBe(true);
    expect((own.body.items as { statusCode: string }[]).some((row) => row.statusCode === 'VOIDED')).toBe(true);
  });

  it('SC-002 20개를 스캔마다 받아도 2초 안이다', async () => {
    const lots = (await issueMaterialLots(fx, batch(ids.supplierW, ids.itemN, 20, 5))).lots;
    const started = Date.now();
    const results = await receiveScans(fx, lots.map((lot) => lot.lotId));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results[19]).toMatchObject({ lotCount: 20, receivedQty: 100 });
  });

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function webPost(path: string): request.Test {
    return sessionPost(path, cookie);
  }

  function webPut(path: string, etag: string): request.Test {
    return request(app.getHttpServer()).put(path).set('Cookie', cookie).set('If-Match', etag).set('Idempotency-Key', idempotencyKey(fx));
  }

  function sessionPost(path: string, sessionCookie: string): request.Test {
    return sessionAuth(sessionCookie)(request(app.getHttpServer()).post(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  function sessionPatch(path: string, sessionCookie: string): request.Test {
    return sessionAuth(sessionCookie)(request(app.getHttpServer()).patch(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  function mobilePost(path: string, key = idempotencyKey(fx), token = mobileToken): request.Test {
    return terminalAuth(token, WORKER_NO)(request(app.getHttpServer()).post(path)).set('Idempotency-Key', key);
  }

  function mobilePatch(path: string): request.Test {
    return terminalAuth(mobileToken, WORKER_NO)(request(app.getHttpServer()).patch(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  function popPost(path: string): request.Test {
    return terminalAuth(popToken, WORKER_NO)(request(app.getHttpServer()).post(path)).set('Idempotency-Key', idempotencyKey(fx));
  }

  async function lineOf(inboundLotId: number) {
    return (await prisma.inbound_lot.findUniqueOrThrow({
      where: { inbound_lot_id: BigInt(inboundLotId) }, include: { inbound_receipt_line: true },
    })).inbound_receipt_line;
  }

  async function versionOf(inboundLotId: number): Promise<number> {
    return (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } })).version_no;
  }

  async function supplierLotOf(lotId: number): Promise<string[]> {
    const rows = await prisma.lot_external_identifier.findMany({ where: { lot_id: BigInt(lotId), identifier_type_code: 'SUPPLIER_LOT' } });
    return rows.map((row) => row.external_identifier);
  }

  async function terminalToken(plant: bigint, type: 'POP' | 'MOBILE'): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입하받기법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입하받기사업부' },
    })).business_unit_id;
    for (const [name, code] of [['plant', 'P'], ['foreignPlant', 'PF']] as const) {
      ids[name] = (await prisma.plant.create({
        data: {
          legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`,
          plant_name: `입하받기공장 ${code}`, timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    for (const [name, code, required] of [['itemA', 'A', true], ['itemB', 'B', true], ['itemN', 'N', false]] as const) {
      ids[name] = (await prisma.item.create({
        data: { item_code: `${PREFIX}-${code}`, item_name: `입하받기자재${code}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea,
          lot_controlled: true, inspection_required: required },
      })).item_id;
    }
    for (const [name, code] of [['supplierS', 'S'], ['supplierT', 'T'], ['supplierU', 'U'], ['supplierV', 'V'], ['supplierW', 'W']] as const) {
      ids[name] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${code}`, partner_name: `${PREFIX} 공급사 ${code}` } })).partner_id;
    }
    ids.worker = (await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '받기작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `입하받기 ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `입하받기 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
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
