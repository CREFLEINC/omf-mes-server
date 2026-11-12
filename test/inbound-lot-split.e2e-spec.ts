/**
 * 피처 005 S11 — 불량 자재 관리 LOT 분리(IQC 단계 `:split-lots`)·선별(처분 단계 SORT)·대시보드 선별 집계(T086 · omf-all-around#254).
 * 분리는 고른 LOT 을 같은 품목·공급사의 새 입하 LOT 으로 옮기고(FR-039), 배정은 「P/O 없음」부터 옮긴다. IQC 단계는 결과를 옮기고(FR-040),
 * 처분 단계는 남은 LOT 을 정상으로·원 부적합을 SORT 로 닫고 새 입하 LOT 에 불합격 확정 기록과 새 부적합을 세운다(FR-041).
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
  IssuedMaterialLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, terminalAuth, sessionAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'ILSP';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const INBOUND_LOTS = '/api/logistics/inbound-lots';
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';
const NONCONFORMANCES = '/api/quality/nonconformances';
const REMAIN = '원래 입하 LOT에 자재 관리 LOT가 하나 이상 남아야 합니다';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8')) as object, 'logistics');
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object, 'shipment');
const schemaOf = (file: string, path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `${file}#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface IqcLot { requestId: number; inboundLotId: number; lots: IssuedMaterialLot[]; supplierId: number; lineIds: bigint[] }

describe('피처 005 S11 자재 관리 LOT 분리·선별 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let noSplitCookie: string;
  let noSortCookie: string;
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
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code), WORKER_NO);
    noSplitCookie = await makeUser('W16', ['W-01-16', 'W-03-10'], `${PREFIX}-W2`);
    noSortCookie = await makeUser('W01', ['W-01-01'], `${PREFIX}-W3`);
    const pop = await terminalToken('POP');
    const mobile = await terminalToken('MOBILE');
    fx = { app, issuer: terminalAuth(pop, WORKER_NO), receiver: terminalAuth(mobile, WORKER_NO), businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US7-1 확정 전 IQC 에서 LOT3 분리 — 미리 보기 → 새 입하 LOT·같은 헤더 새 줄·결과 A 이동·B 의 LOT3 매칭 삭제·배정 P/O 없음 500 + A 500 → 각각 확정', async () => {
    const iqc = await iqcLot(1_000, 3, [2_500]);
    const [lot1, lot2, lot3] = iqc.lots;
    const resultB = await addResult(iqc.requestId, { inspectedQty: 3_000, acceptedQty: 3_000, matchedLotIds: [lot1.lotId, lot2.lotId, lot3.lotId] });
    const resultA = await addResult(iqc.requestId, {
      inspectedQty: 1_000, acceptedQty: 0, rejectedQty: 1_000, overallJudgmentCode: 'REJECTED', matchedLotIds: [lot3.lotId],
    });
    const source = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) }, include: { inbound_receipt_line: true } });
    const poNo = (await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: iqc.lineIds[0] }, include: { purchase_order: true } })).purchase_order.purchase_order_no;
    const allocations = [
      { purchaseOrderLineId: null, purchaseOrderNo: null, lineNo: null, qty: 500 },
      { purchaseOrderLineId: Number(iqc.lineIds[0]), purchaseOrderNo: poNo, lineNo: 1, qty: 500 },
    ];

    const preview = await request(app.getHttpServer()).get(`${INBOUND_LOTS}/${String(iqc.inboundLotId)}/split-preview`)
      .query({ lotIds: String(lot3.lotId) }).set('Cookie', cookie).expect(200);
    expectShape(schemaOf('logistics', '/logistics/inbound-lots/{inboundLotId}/split-preview', 'get', 200), preview.body);
    expect(preview.body).toEqual({
      movedLotCount: 1, movedQty: 1_000, remainingLotCount: 2, remainingQty: 2_000, newInspectionInProgress: true,
      movedResults: [{ inspectionResultId: resultA, seqNo: 2, overallJudgmentCode: 'REJECTED' }],
      unmatchedResults: [{ inspectionResultId: resultB, seqNo: 1, removedLotIds: [lot3.lotId] }],
      keptResults: [], movedAllocations: allocations,
    });

    const split = await splitLots(iqc.inboundLotId, [lot3.lotId], source.version_no).expect(201);
    expectShape(schemaOf('logistics', '/logistics/inbound-lots/{inboundLotId}:split-lots', 'post', 201), split.body);
    expect(split.body).toMatchObject({ movedLotIds: [lot3.lotId], movedResultIds: [resultA], movedAllocations: allocations });
    expect(split.body.inboundLot).toMatchObject({ statusCode: 'RECEIVED', receivedQty: 1_000, lotCount: 1, unallocatedQty: 500, inboundReceiptNo: expect.any(String) as string });
    const newId = BigInt(split.body.inboundLot.inboundLotId as number);
    const created = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: newId }, include: { inbound_receipt_line: { include: { inbound_receipt_po_allocation: true } } } });
    expect(created).toMatchObject({
      status_code: 'RECEIVED', split_from_inbound_lot_id: source.inbound_lot_id, erp_send_mode_code: source.erp_send_mode_code,
      receiving_date: source.receiving_date, supplier_id: source.supplier_id, item_id: source.item_id,
    });
    expect(created.inbound_receipt_line.inbound_receipt_id).toBe(source.inbound_receipt_line.inbound_receipt_id);
    expect(Number(created.inbound_receipt_line.received_qty)).toBe(1_000);
    expect(created.inbound_receipt_line.inbound_receipt_po_allocation.map((row) => [row.purchase_order_line_id, Number(row.allocated_qty)])).toEqual([[iqc.lineIds[0], 500]]);
    const original = await prisma.inbound_receipt_line.findUniqueOrThrow({ where: { inbound_receipt_line_id: source.inbound_receipt_line_id }, include: { inbound_receipt_po_allocation: true } });
    expect(Number(original.received_qty)).toBe(2_000);
    expect(original.inbound_receipt_po_allocation.map((row) => Number(row.allocated_qty))).toEqual([2_000]);
    expect(Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: iqc.lineIds[0] } })).received_qty)).toBe(2_500);
    const moved = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lot3.lotId) } });
    expect(moved).toMatchObject({ lot_no: lot3.lotNo, inbound_lot_id: newId, source_id: created.inbound_receipt_line_id });

    const newRequestId = split.body.inspectionRequestId as number;
    const newRequest = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(newRequestId) }, include: { inspection_result: true } });
    expect(newRequest).toMatchObject({ status_code: 'IN_PROGRESS', inbound_lot_id: newId, target_type_code: 'INBOUND_LOT' });
    expect(Number(newRequest.target_qty)).toBe(1_000);
    expect(newRequest.inspection_result.map((row) => [Number(row.inspection_result_id), row.inspection_round])).toEqual([[resultA, 1]]);
    expect(Number((await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } })).target_qty)).toBe(2_000);
    const matches = await prisma.inspection_result_lot.findMany({ where: { inspection_result_id: BigInt(resultB) }, orderBy: { lot_id: 'asc' } });
    expect(matches.map((row) => Number(row.lot_id))).toEqual([lot1.lotId, lot2.lotId]);
    expect(await eventCodes(iqc.requestId)).toContain('SPLIT_OUT');
    expect(await eventCodes(newRequestId)).toContain('SPLIT_IN');
    expect(await prisma.inbound_lot_event.count({ where: { inbound_lot_id: { in: [source.inbound_lot_id, newId] }, event_type_code: 'SPLIT' } })).toBe(2);

    await confirm(iqc.requestId);
    await confirm(newRequestId);
    expect(await lotStatus(lot1.lotId)).toBe('NORMAL');
    expect(await lotStatus(lot2.lotId)).toBe('NORMAL');
    expect(await lotStatus(lot3.lotId)).toBe('DEFECTIVE');
    expect(await prisma.nonconformance.count({ where: { inspection_request_id: BigInt(newRequestId), status_code: 'PENDING_DECISION' } })).toBe(1);
  });

  it('US7-4 LOT 전부를 고르면 400 「원래 입하 LOT에 … 남아야 합니다」, 판정 확정 뒤 분리는 409', async () => {
    const iqc = await iqcLot(10, 3);
    const all = iqc.lots.map((lot) => lot.lotId);
    const version = await inboundVersion(iqc.inboundLotId);
    const refused = await splitLots(iqc.inboundLotId, all, version).expect(400);
    expect(JSON.stringify(refused.body)).toContain(REMAIN);
    await request(app.getHttpServer()).get(`${INBOUND_LOTS}/${String(iqc.inboundLotId)}/split-preview`).query({ lotIds: all.join(',') })
      .set('Cookie', cookie).expect(400);
    expect(await prisma.lot.count({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) } })).toBe(3);

    await addResult(iqc.requestId, { inspectedQty: 30, acceptedQty: 30, matchedLotIds: all });
    await confirm(iqc.requestId);
    await splitLots(iqc.inboundLotId, [all[2]], await inboundVersion(iqc.inboundLotId)).expect(409);
  });

  it('US7-2 불합격 부적합(LOT1·2·3) SORT LOT3 + 정보 수량 → LOT1·2 정상·원 부적합 SORT 닫힘·새 입하 LOT·불합격 확정 기록(결과 복사)·새 부적합·배정 이전', async () => {
    const nc = await rejectedIqc([25]);
    const [lot1, lot2, lot3] = nc.lots;
    const response = await decide(nc.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [lot3.lotId], goodQty: 25, defectQty: 5, reason: '외관 선별' }, 201);
    expectShape(schemaOf('quality', '/quality/nonconformances/{nonconformanceId}/disposition-decisions', 'post', 201), response.body);
    expect(response.body).toMatchObject({ dispositionTypeCode: 'SORT', decisionQty: 20, sortGoodQty: 25, sortDefectQty: 5 });
    expect(await lotStatus(lot1.lotId)).toBe('NORMAL');
    expect(await lotStatus(lot2.lotId)).toBe('NORMAL');
    expect(await lotStatus(lot3.lotId)).toBe('DEFECTIVE');
    expect(await prisma.lot_hold.count({ where: { lot_id: { in: [BigInt(lot1.lotId), BigInt(lot2.lotId)] }, reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null } })).toBe(0);
    const source = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformanceId }, include: { nonconformance_lot: true, disposition_decision: true } });
    expect(source.status_code).toBe('DECIDED');
    expect(source.nonconformance_lot.map((row) => Number(row.lot_id)).sort()).toEqual([lot1.lotId, lot2.lotId].sort());
    expect(source.disposition_decision.map((row) => [row.disposition_type_code, Number(row.decision_qty), Number(row.sort_good_qty), Number(row.sort_defect_qty)])).toEqual([['SORT', 20, 25, 5]]);
    const listed = await request(app.getHttpServer()).get(`${NONCONFORMANCES}/${String(nc.nonconformanceId)}/disposition-decisions`).set('Cookie', cookie).expect(200);
    expect(listed.body.items[0]).toMatchObject({ dispositionTypeCode: 'SORT', sortGoodQty: 25, sortDefectQty: 5 });

    const newInboundLotId = BigInt(response.body.newInboundLotId as number);
    const newInbound = await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: newInboundLotId }, include: { inbound_receipt_line: { include: { inbound_receipt_po_allocation: true } } } });
    expect(newInbound).toMatchObject({ inbound_lot_no: response.body.newInboundLotNo, status_code: 'RECEIVED', split_from_inbound_lot_id: BigInt(nc.inboundLotId) });
    // 배정 A 25·P/O 없음 5 에서 LOT3(10) — P/O 없음 5 + A 5.
    expect(newInbound.inbound_receipt_line.inbound_receipt_po_allocation.map((row) => Number(row.allocated_qty))).toEqual([5]);
    const newRequest = await prisma.inspection_request.findFirstOrThrow({
      where: { inbound_lot_id: newInboundLotId }, include: { inspection_result: { include: { inspection_result_lot: true } } },
    });
    expect(newRequest).toMatchObject({
      inspection_request_no: response.body.newInspectionRequestNo, status_code: 'COMPLETED', overall_judgment_code: 'REJECTED',
      split_from_inspection_request_id: BigInt(nc.requestId),
    });
    expect(newRequest.confirmed_at).not.toBeNull();
    expect(newRequest.inspection_result.map((row) => [row.inspection_round, row.status_code, row.overall_judgment_code, row.inspection_result_lot.map((match) => Number(match.lot_id))]))
      .toEqual([[1, 'CONFIRMED', 'REJECTED', [lot3.lotId]]]);
    // 원래 결과는 그대로 — 원래 판정의 근거.
    const originalResult = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(nc.rejectedResultId) }, include: { inspection_result_lot: true } });
    expect(originalResult).toMatchObject({ inspection_request_id: BigInt(nc.requestId), status_code: 'CONFIRMED' });
    expect(originalResult.inspection_result_lot.map((match) => Number(match.lot_id))).toEqual([lot3.lotId]);

    const split = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: BigInt(response.body.newNonconformanceId as number) }, include: { nonconformance_lot: true } });
    expect(split).toMatchObject({
      nonconformance_no: response.body.newNonconformanceNo, status_code: 'PENDING_DECISION', source_nonconformance_id: nc.nonconformanceId,
      inspection_request_id: newRequest.inspection_request_id, inspection_result_id: newRequest.inspection_result[0].inspection_result_id,
    });
    expect(split.nonconformance_lot.map((row) => [Number(row.lot_id), Number(row.affected_qty)])).toEqual([[lot3.lotId, 10]]);
    const supplier = await prisma.partner.findUniqueOrThrow({ where: { partner_id: BigInt(nc.supplierId) } });
    const detail = await request(app.getHttpServer()).get(`${NONCONFORMANCES}/${String(split.nonconformance_id)}`).set('Cookie', cookie).expect(200);
    expectShape(schemaOf('shipment', '/quality/nonconformances/{nonconformanceId}', 'get', 200), detail.body);
    expect(detail.body).toMatchObject({
      inboundLotId: Number(newInboundLotId), inspectionRequestNo: response.body.newInspectionRequestNo, supplierName: supplier.partner_name,
      sortedFromNonconformanceId: Number(nc.nonconformanceId), sortedFromNonconformanceNo: source.nonconformance_no, unmatchedResults: [],
    });
    expect(detail.body.lots[0].matchedResults).toEqual([
      { inspectionResultId: Number(newRequest.inspection_result[0].inspection_result_id), seqNo: 1, overallJudgmentCode: 'REJECTED', defectSummary: null },
    ]);
  });

  it('US7-2 정보 수량 없이 보내면 null · 판정이 이미 있는 부적합 선별은 409', async () => {
    const nc = await rejectedIqc();
    const response = await decide(nc.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [nc.lots[2].lotId], reason: '선별' }, 201);
    expect(response.body).toMatchObject({ sortGoodQty: null, sortDefectQty: null });

    const decided = await rejectedIqc();
    await prisma.disposition_decision.create({
      data: { nonconformance_id: decided.nonconformanceId, disposition_type_code: 'REWORK', decision_qty: 5, uom_id: ids.ea, reason: '일부', decided_by: ids.user, decided_at: new Date() },
    });
    await decide(decided.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [decided.lots[2].lotId], reason: '선별' }, 409);
    const fresh = await rejectedIqc();
    const refused = await decide(fresh.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: fresh.lots.map((lot) => lot.lotId), reason: '선별' }, 400);
    expect(JSON.stringify(refused.body)).toContain(REMAIN);
  });

  it('US7-3 선별로 생긴 부적합의 재작업 → 새 입하 LOT 의 IQC 가 다시 열림 → 재검 합격으로 다시 확정 · 정상·선별은 400', async () => {
    const nc = await rejectedIqc();
    const sorted = await decide(nc.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [nc.lots[2].lotId], reason: '선별' }, 201);
    const splitNc = BigInt(sorted.body.newNonconformanceId as number);
    await decide(splitNc, { dispositionTypeCode: 'REWORK', decisionQty: 10, uomId: Number(ids.ea), reason: '재작업' }, 201);
    const reopened = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot_id: BigInt(sorted.body.newInboundLotId as number) } });
    expect(reopened).toMatchObject({ status_code: 'IN_PROGRESS', confirm_cycle: 2, confirmed_at: null });
    expect(await lotStatus(nc.lots[2].lotId)).toBe('INSPECTION_PENDING');

    // 선별로 생긴 부적합은 폐기·재작업·특채만(FR-041) — 정상·선별은 400.
    const other = await rejectedIqc();
    const child = BigInt((await decide(other.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [other.lots[1].lotId, other.lots[2].lotId], reason: '선별' }, 201)).body.newNonconformanceId as number);
    await decide(child, { dispositionTypeCode: 'NORMAL', decisionQty: 20, uomId: Number(ids.ea), reason: '정상' }, 400);
    await decide(child, { dispositionTypeCode: 'SORT', lotIds: [other.lots[2].lotId], reason: '선별' }, 400);

    await addResult(Number(reopened.inspection_request_id), { inspectedQty: 10, acceptedQty: 10, matchedLotIds: [nc.lots[2].lotId], reinspectionReasonCode: `${PREFIX}-RT` });
    const confirmed = await confirm(Number(reopened.inspection_request_id));
    expect(confirmed.body).toMatchObject({ statusCode: 'COMPLETED', overallJudgmentCode: 'ACCEPTED' });
    expect(await lotStatus(nc.lots[2].lotId)).toBe('NORMAL');
  });

  it('R14b-1 대시보드 「IQC 선별 처분」 — 새 선별은 분리한 자재 관리 LOT, 옛 선별(수량 분할)은 원래 검사 LOT 그대로', async () => {
    const before = await sortedLots();
    const nc = await rejectedIqc();
    await decide(nc.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [nc.lots[1].lotId, nc.lots[2].lotId], reason: '선별' }, 201);
    const legacy = await legacySort();

    const after = await sortedLots();
    expect(after.summary).toBe(before.summary + 3);
    expect(after.list.lotCount).toBe(before.list.lotCount + 3);
    expect(after.list.recordCount).toBe(before.list.recordCount + 2);
    const ncNo = (await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformanceId } })).nonconformance_no;
    const rows = (refNo: string) => after.list.items.filter((row) => row.refNo === refNo).map((row) => row.lotNo).sort();
    expect(rows(ncNo)).toEqual([nc.lots[1].lotNo, nc.lots[2].lotNo].sort());
    expect(rows(legacy.nonconformanceNo)).toEqual([legacy.lotNo]);
  });

  it('권한 — :split-lots·split-preview 는 W-01-01, SORT 는 W-03-10 이 없으면 403', async () => {
    const iqc = await iqcLot(10, 2);
    await splitLots(iqc.inboundLotId, [iqc.lots[1].lotId], await inboundVersion(iqc.inboundLotId), noSplitCookie).expect(403);
    await request(app.getHttpServer()).get(`${INBOUND_LOTS}/${String(iqc.inboundLotId)}/split-preview`).query({ lotIds: String(iqc.lots[1].lotId) })
      .set('Cookie', noSplitCookie).expect(403);
    await request(app.getHttpServer()).get(`${INBOUND_LOTS}/${String(iqc.inboundLotId)}/split-preview`).query({ lotIds: String(iqc.lots[1].lotId) })
      .set('Cookie', noSortCookie).expect(200);
    const nc = await rejectedIqc();
    await decide(nc.nonconformanceId, { dispositionTypeCode: 'SORT', lotIds: [nc.lots[2].lotId], reason: '선별' }, 403, noSortCookie);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function newSupplier(): Promise<number> {
    seq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S${String(seq)}`, partner_name: `${PREFIX} 공급사 ${String(seq)}` } });
    return Number(supplier.partner_id);
  }

  /** 입하 마감까지(배정은 P/O 라인 `orders` 발주량으로) — IQC 요청이 선다. */
  async function iqcLot(lotQty: number, lotCount: number, orders: number[] = []): Promise<IqcLot> {
    const supplierId = await newSupplier();
    const lineIds: bigint[] = [];
    for (const ordered of orders) lineIds.push(await makeOrderLine(BigInt(supplierId), ordered));
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId, itemId: Number(ids.item), lotQty, lotCount });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    if (closed.iqcRequestId === null) throw new Error('입하 마감이 IQC 요청을 세우지 않았다');
    return { requestId: closed.iqcRequestId, inboundLotId: inboundLot.inboundLotId, lots, supplierId, lineIds };
  }

  /** LOT 3개(각 10) — 결과 1 = 전부 합격, 결과 2 = LOT3 만 불합격 → 확정이 부적합(LOT 전부)을 세운다. */
  async function rejectedIqc(orders: number[] = []): Promise<IqcLot & { nonconformanceId: bigint; rejectedResultId: number }> {
    const iqc = await iqcLot(10, 3, orders);
    await addResult(iqc.requestId, { inspectedQty: 30, acceptedQty: 30, matchedLotIds: iqc.lots.map((lot) => lot.lotId) });
    const rejectedResultId = await addResult(iqc.requestId, {
      inspectedQty: 10, acceptedQty: 0, rejectedQty: 10, overallJudgmentCode: 'REJECTED', matchedLotIds: [iqc.lots[2].lotId],
    });
    await confirm(iqc.requestId);
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId), status_code: 'PENDING_DECISION' } });
    return { ...iqc, nonconformanceId: nc.nonconformance_id, rejectedResultId };
  }

  async function addResult(requestId: number, overrides: Record<string, unknown>): Promise<number> {
    const body = {
      inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', ...overrides,
    };
    const response = await request(app.getHttpServer()).post(RESULTS).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(201);
    return response.body.inspectionResultId as number;
  }

  async function confirm(requestId: number): Promise<request.Response> {
    const { version_no: versionNo } = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } });
    return request(app.getHttpServer()).post(`${REQUESTS}/${String(requestId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo }).expect(200);
  }

  function splitLots(inboundLotId: number, lotIds: number[], versionNo: number, as = cookie): request.Test {
    return request(app.getHttpServer()).post(`${INBOUND_LOTS}/${String(inboundLotId)}:split-lots`).set('Cookie', as)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ lotIds, versionNo, reason: '불량 LOT 분리' });
  }

  async function decide(nonconformanceId: bigint, body: Record<string, unknown>, status: number, as = cookie): Promise<request.Response> {
    const { version_no: version } = await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nonconformanceId } });
    return request(app.getHttpServer()).post(`${NONCONFORMANCES}/${String(nonconformanceId)}/disposition-decisions`)
      .set('Cookie', as).set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`).send(body).expect(status);
  }

  async function inboundVersion(inboundLotId: number): Promise<number> {
    return (await prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } })).version_no;
  }

  async function lotStatus(lotId: number): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) } })).status_code;
  }

  async function eventCodes(requestId: number): Promise<string[]> {
    const events = await prisma.inspection_request_event.findMany({ where: { inspection_request_id: BigInt(requestId) } });
    return events.map((event) => event.event_type_code);
  }

  async function sortedLots(): Promise<{ summary: number; list: { lotCount: number; recordCount: number; items: { lotNo: string; refNo: string }[] } }> {
    const query = { plantId: ids.plant.toString(), baseDate: DAY };
    const summary = await request(app.getHttpServer()).get('/api/app/dashboard-summary').query(query).set('Cookie', cookie).expect(200);
    const list = await request(app.getHttpServer()).get('/api/app/dashboard-quality-lots').query({ ...query, status: 'IQC_SORTED' }).set('Cookie', cookie).expect(200);
    return { summary: (summary.body as { quality: { iqc: { sortedLotCount: number } } }).quality.iqc.sortedLotCount, list: list.body as never };
  }

  /** 옛 수량 분할 선별 기록 — LOT 대상 IQC 요청·결과·부적합·SORT 판정(FR-038 전 데이터). */
  async function legacySort(): Promise<{ nonconformanceNo: string; lotNo: string }> {
    const { lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: await newSupplier(), itemId: Number(ids.item), lotQty: 10, lotCount: 1 });
    const lotId = BigInt(lots[0].lotId);
    seq += 1;
    const legacy = await prisma.inspection_request.create({
      data: { inspection_request_no: `${PREFIX}-IR-${String(seq)}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lotId, item_id: ids.item,
        lot_id: lotId, target_qty: 10, uom_id: ids.ea, status_code: 'COMPLETED', requested_at: new Date() },
    });
    const result = await prisma.inspection_result.create({
      data: { inspection_result_no: `${PREFIX}-RS-${String(seq)}`, inspection_request_id: legacy.inspection_request_id, inspected_qty: 10, rejected_qty: 10,
        uom_id: ids.ea, overall_judgment_code: 'REJECTED', inspector_id: ids.worker, inspected_at: new Date(), confirmed_at: new Date(),
        status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-${String(seq)}` },
    });
    const nc = await prisma.nonconformance.create({
      data: { nonconformance_no: `${PREFIX}-NC-${String(seq)}`, item_id: ids.item, inspection_result_id: result.inspection_result_id, severity_code: 'MAJOR',
        description: '옛 선별', status_code: 'DECIDED', opened_at: new Date(), closed_at: new Date() },
    });
    await prisma.disposition_decision.create({
      data: { nonconformance_id: nc.nonconformance_id, disposition_type_code: 'SORT', decision_qty: 10, uom_id: ids.ea, reason: '옛 선별', decided_by: ids.user, decided_at: new Date() },
    });
    return { nonconformanceNo: nc.nonconformance_no, lotNo: lots[0].lotNo };
  }

  async function makeOrderLine(supplierId: bigint, ordered: number): Promise<bigint> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: { purchase_order_no: `${PREFIX}-PO-${String(seq)}`, supplier_id: supplierId, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED' },
    });
    const line = await prisma.purchase_order_line.create({
      data: { purchase_order_id: order.purchase_order_id, line_no: 1, item_id: ids.item, uom_id: ids.ea, ordered_qty: ordered, received_qty: 0, tolerance_over_qty: 0 },
    });
    return line.purchase_order_line_id;
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '분리법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '분리사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '분리공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '분리자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
  }

  async function makeUser(suffix: string, permissions: string[], workerNo: string): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `${PREFIX} ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const worker = await prisma.worker.create({
      data: { worker_no: workerNo, worker_name: `분리 ${suffix}`, business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
    });
    if (workerNo === WORKER_NO) {
      ids.user = user.app_user_id;
      ids.worker = worker.worker_id;
    }
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
    const ncs = `SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (${items})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts})) OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lots}))`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.defect_record WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.concession WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `UPDATE quality.nonconformance SET source_nonconformance_id = NULL WHERE item_id IN (${items})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.item_inspection_level_history WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `UPDATE quality.inspection_request SET split_from_inspection_request_id = NULL WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `UPDATE trace.inbound_lot SET split_from_inbound_lot_id = NULL WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
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
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
