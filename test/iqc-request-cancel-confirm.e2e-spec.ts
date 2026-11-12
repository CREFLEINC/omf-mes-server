/**
 * 피처 005 S9 — 입하 LOT IQC 판정 확정 취소(T081 · omf-all-around#254).
 * `POST /quality/inspection-requests/{id}:cancel-confirm`(W-01-15): 입고·처분·특채·IQC 밖 상태 변경이 없을 때만(R-13 · plan 확인할 것 4),
 * 결과 DRAFT·LOT 검사 대기(C29)·보류 다시·부적합 CANCELLED·요청 IN_PROGRESS·확정 주기 + 1. 응답은 ajv 로 계약 대조.
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
  IssuedMaterialLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth, defaultMatchedLotIds,
} from './support/inbound-lot-fixture';

const PREFIX = 'IQCC';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';
const CANCEL_PATH = '/quality/inspection-requests/{inspectionRequestId}:cancel-confirm';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
const schemaOf = (path: string, method: string, status: number): ValidateFunction => ajv.compile({
  $ref: `quality#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${String(status)}/content/application~1json/schema`,
});
function expectShape(validate: ValidateFunction, body: unknown): void {
  validate(body);
  expect(validate.errors ?? []).toEqual([]);
}

interface ResultRow { inspectionResultId: number; inspectionRound: number; versionNo: number }
interface IqcLot { requestId: number; inboundLotId: number; lots: IssuedMaterialLot[] }

describe('피처 005 S9 입하 LOT IQC 판정 확정 취소 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let recorder: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let supplierSeq = 0;
  let legacySeq = 0;
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
    recorder = await makeUser('REC', ['W-01-01'], `${PREFIX}-W2`);
    const pop = await terminalToken('POP');
    const mobile = await terminalToken('MOBILE');
    fx = { app, issuer: terminalAuth(pop, WORKER_NO), receiver: terminalAuth(mobile, WORKER_NO), businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US5-1·SC-006 합격 확정 취소(입고 전) → LOT 검사 대기(C29)·보류 다시·결과 DRAFT·요청 IN_PROGRESS·확정 칸 비움·주기 + 1·이력 CONFIRM_CANCELLED', async () => {
    const iqc = await iqcLot(3);
    await addResult(iqc.requestId);
    await addResult(iqc.requestId, { matchedLotIds: [iqc.lots[0].lotId] });
    await confirm(iqc.requestId);
    expect(await openInspectionHolds(iqc)).toBe(0);

    const response = await cancel(iqc.requestId, 200, { reason: '판정 재검토' });
    expectShape(schemaOf(CANCEL_PATH, 'post', 200), response.body);
    expect(response.body).toMatchObject({ statusCode: 'IN_PROGRESS', confirmedByName: null, nonconformanceId: null });
    expect([response.body.overallJudgmentCode ?? null, response.body.confirmedAt ?? null]).toEqual([null, null]);
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING', 'INSPECTION_PENDING']);
    expect(await openInspectionHolds(iqc)).toBe(3);
    const c29 = await prisma.lot_status_event.findMany({ where: { lot_id: { in: lotIdsOf(iqc) }, transition_code: 'C29' } });
    expect(c29).toHaveLength(3);
    expect(c29.every((event) => event.source_document_type_code === 'INSPECTION_REQUEST' && event.source_document_id === BigInt(iqc.requestId))).toBe(true);
    const results = await prisma.inspection_result.findMany({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    expect(results.map((row) => [row.status_code, row.confirmed_at])).toEqual([['DRAFT', null], ['DRAFT', null]]);
    const row = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    expect(row).toMatchObject({ status_code: 'IN_PROGRESS', overall_judgment_code: null, confirmed_at: null, confirmed_by: null, confirm_cycle: 2 });

    const event = await prisma.inspection_request_event.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId), event_type_code: 'CONFIRM_CANCELLED' } });
    expect(event).toMatchObject({ actor_user_id: ids.user, reason: '판정 재검토', summary_before: expect.objectContaining({ overallJudgmentCode: 'ACCEPTED', statusCode: 'COMPLETED' }) as unknown });
    const history = await request(app.getHttpServer()).get(`${REQUESTS}/${String(iqc.requestId)}/history`).set('Cookie', cookie).expect(200);
    expect((history.body.requestEvents as { eventCode: string }[]).map((line) => line.eventCode)).toEqual(['REQUESTED', 'RESULT_ADDED', 'RESULT_ADDED', 'CONFIRMED', 'CONFIRM_CANCELLED']);
  });

  it('SC-005 취소 뒤 모든 결과를 고치고 지우고 더할 수 있다 — 새 결과는 확정 주기 2(재검사)', async () => {
    const iqc = await iqcLot(1);
    const first = await addResult(iqc.requestId);
    const second = await addResult(iqc.requestId);
    await confirm(iqc.requestId);
    await cancel(iqc.requestId, 200);
    const firstVersion = (await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(first.inspectionResultId) } })).version_no;
    await request(app.getHttpServer()).put(`${RESULTS}/${String(first.inspectionResultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(firstVersion)}"`).send({ remarks: '취소 뒤 수정' }).expect(200);
    const secondVersion = (await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(second.inspectionResultId) } })).version_no;
    await request(app.getHttpServer()).delete(`${RESULTS}/${String(second.inspectionResultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(secondVersion)}"`).expect(204);
    const added = await addResult(iqc.requestId);
    expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(added.inspectionResultId) } })).confirm_cycle).toBe(2);
  });

  it('US5-2·SC-006 불합격 확정 취소(처분 전) → 부적합 CANCELLED(closed_at)·LOT 검사 대기·보류는 한 벌 — 다시 불합격 확정하면 알림 다시', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId, { acceptedQty: 6, rejectedQty: 4, overallJudgmentCode: 'REJECTED' });
    await confirm(iqc.requestId);
    expect(await lotStatuses(iqc)).toEqual(['DEFECTIVE', 'DEFECTIVE']);
    await cancel(iqc.requestId, 200);
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    expect(nc.status_code).toBe('CANCELLED');
    expect(nc.closed_at).not.toBeNull();
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
    expect(await openInspectionHolds(iqc)).toBe(2);
    expect(await rejectedAlerts(iqc)).toBe(1);
    // 다시 불합격으로 확정하면 새 부적합이 서고, 옮길 LOT 이 다시 생겼으니 알림도 다시 나간다.
    await confirm(iqc.requestId);
    expect(await prisma.nonconformance.count({ where: { inspection_request_id: BigInt(iqc.requestId), status_code: 'PENDING_DECISION' } })).toBe(1);
    expect(await rejectedAlerts(iqc)).toBe(2);
  });

  it('US5-3·SC-006 자재 관리 LOT 하나가 입고된 뒤 → 409 GOODS_RECEIVED(그 LOT 번호) — LOT·결과·요청 그대로', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId);
    await confirm(iqc.requestId);
    await receiveGoods(iqc.lots[1].lotId);
    const response = await cancel(iqc.requestId, 409);
    expectShape(schemaOf(CANCEL_PATH, 'post', 409), response.body);
    expect(response.body.errors).toEqual([expect.objectContaining({ scope: 'screen', code: 'GOODS_RECEIVED', lotNos: [iqc.lots[1].lotNo] })]);
    expect(await lotStatuses(iqc)).toEqual(['NORMAL', 'NORMAL']);
    expect(await requestStatus(iqc.requestId)).toBe('COMPLETED');
  });

  it('US5-4·SC-006 처분 판정·특채 뒤 → 409 DISPOSITION_STARTED·CONCESSION_EXISTS — 부적합 그대로', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId, { acceptedQty: 0, rejectedQty: 10, overallJudgmentCode: 'REJECTED' });
    await confirm(iqc.requestId);
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    await prisma.disposition_decision.create({
      data: { nonconformance_id: nc.nonconformance_id, disposition_type_code: 'SCRAP', decision_qty: 1, uom_id: ids.ea, reason: '시험', decided_by: ids.user, decided_at: new Date() },
    });
    await concession(nc.nonconformance_id, BigInt(iqc.lots[0].lotId));
    const response = await cancel(iqc.requestId, 409);
    expectShape(schemaOf(CANCEL_PATH, 'post', 409), response.body);
    expect((response.body.errors as { code: string; lotNos: string[] }[]).map((error) => [error.code, error.lotNos])).toEqual([
      ['DISPOSITION_STARTED', iqc.lots.map((lot) => lot.lotNo)],
      ['CONCESSION_EXISTS', [iqc.lots[0].lotNo]],
    ]);
    expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc.nonconformance_id } })).status_code).toBe('PENDING_DECISION');
    expect(await lotStatuses(iqc)).toEqual(['DEFECTIVE', 'DEFECTIVE']);
  });

  it('US5-4 확정 뒤 다른 이유의 LOT 상태 변경 → 409 LOT_STATUS_CHANGED — 확정이 남긴 이력은 세지 않는다', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId);
    await confirm(iqc.requestId);
    await prisma.lot_status_event.create({
      data: { lot_id: BigInt(iqc.lots[0].lotId), previous_status_code: 'NORMAL', new_status_code: 'INSPECTION_PENDING', quality_status_code: 'INSPECTION_PENDING',
        transition_code: 'C10', changed_by: ids.user, changed_at: new Date() },
    });
    const response = await cancel(iqc.requestId, 409);
    expect(response.body.errors).toEqual([expect.objectContaining({ code: 'LOT_STATUS_CHANGED', lotNos: [iqc.lots[0].lotNo] })]);
  });

  it('US5-5 보류 확정 → 취소 → 결과 고치고 더함 → 재확정이 새 종합 판정(합격)·LOT 정상', async () => {
    const iqc = await iqcLot(2);
    const held = await addResult(iqc.requestId, { acceptedQty: 5, heldQty: 5, overallJudgmentCode: 'HELD' });
    await confirm(iqc.requestId);
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
    await cancel(iqc.requestId, 200);
    expect(await openInspectionHolds(iqc)).toBe(2);
    const version = (await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(held.inspectionResultId) } })).version_no;
    await request(app.getHttpServer()).put(`${RESULTS}/${String(held.inspectionResultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(version)}"`)
      .send({ acceptedQty: 10, heldQty: 0, overallJudgmentCode: 'ACCEPTED' }).expect(200);
    await addResult(iqc.requestId);
    const response = await confirm(iqc.requestId);
    expect(response.body).toMatchObject({ overallJudgmentCode: 'ACCEPTED', statusCode: 'COMPLETED' });
    expect(await lotStatuses(iqc)).toEqual(['NORMAL', 'NORMAL']);
    expect(await openInspectionHolds(iqc)).toBe(0);
  });

  it('R19-1·SC-005 W-01-15 가 없으면 확정 취소 403 — 확정 그대로', async () => {
    const iqc = await iqcLot(1);
    await addResult(iqc.requestId);
    await confirm(iqc.requestId);
    await cancel(iqc.requestId, 403, {}, recorder);
    expect(await requestStatus(iqc.requestId)).toBe('COMPLETED');
  });

  it('확정되지 않은 요청·이전된 옛 요청의 확정 취소는 409 INVALID_STATE', async () => {
    const iqc = await iqcLot(1);
    await addResult(iqc.requestId);
    const open = await cancel(iqc.requestId, 409);
    expectShape(schemaOf(CANCEL_PATH, 'post', 409), open.body);
    expect(open.body).toMatchObject({ code: 'INVALID_STATE' });
    const legacy = await legacyIqc(5);
    const refused = await cancel(legacy.requestId, 409);
    expect(refused.body).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('이전 데이터') as string });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function iqcLot(lotCount: number): Promise<IqcLot> {
    supplierSeq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S${String(supplierSeq)}`, partner_name: `${PREFIX} 공급사 ${String(supplierSeq)}` } });
    const { inboundLot, lots } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: Number(supplier.partner_id), itemId: Number(ids.item), lotQty: 10, lotCount });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    if (closed.iqcRequestId === null) throw new Error('입하 마감이 IQC 요청을 세우지 않았다');
    return { requestId: closed.iqcRequestId, inboundLotId: inboundLot.inboundLotId, lots };
  }

  /** 이전된 옛 IQC 요청 — 대상 LOT·`lot_id` 있음·`inbound_lot_id` 만 채움(데이터 이전 3). */
  async function legacyIqc(qty: number): Promise<{ requestId: number; lotId: number }> {
    legacySeq += 1;
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-LS${String(legacySeq)}`, partner_name: `${PREFIX} 옛 공급사` } });
    const at = new Date(`${DAY}T02:00:00.000Z`);
    const receipt = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-L${String(legacySeq)}`, supplier_id: supplier.partner_id, plant_id: ids.plant, receipt_datetime: at, status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: qty, uom_id: ids.ea,
        supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    const inbound = await prisma.inbound_lot.create({
      data: { inbound_lot_no: `IL-MIG-${String(line.inbound_receipt_line_id)}`, plant_id: ids.plant, item_id: ids.item, supplier_id: supplier.partner_id, uom_id: ids.ea,
        status_code: 'RECEIVED', receiving_date: new Date(`${DAY}T00:00:00.000Z`), received_closed_at: at, erp_send_mode_code: 'PER_RECEIPT',
        inbound_receipt_line_id: line.inbound_receipt_line_id },
    });
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-LEGACY-${String(legacySeq)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'INSPECTION_PENDING', inbound_lot_id: inbound.inbound_lot_id },
    });
    await prisma.lot_hold.create({
      data: { lot_id: lot.lot_id, reason_code: 'INCOMING_INSPECTION_WAIT', status_code: 'HELD', target_lot_status_code: 'INSPECTION_PENDING', held_by: ids.user, held_at: at },
    });
    const iqc = await prisma.inspection_request.create({
      data: { inspection_request_no: `${PREFIX}-IQC-L${String(legacySeq)}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: ids.item, lot_id: lot.lot_id, inbound_lot_id: inbound.inbound_lot_id, target_qty: qty, uom_id: ids.ea, status_code: 'REQUESTED', requested_at: at },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return { requestId: Number(iqc.inspection_request_id), lotId: Number(lot.lot_id) };
  }

  function resultBody(requestId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {
      inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', ...overrides,
    };
    return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  }

  function postResult(body: Record<string, unknown>, as = cookie): request.Test {
    return request(app.getHttpServer()).post(RESULTS).set('Cookie', as).set('Idempotency-Key', idempotencyKey(fx)).send(body);
  }

  async function addResult(requestId: number, overrides: Record<string, unknown> = {}): Promise<ResultRow> {
    // 2026-11-12 매칭 필수 — 칸을 주지 않은 결과는 차례대로 LOT 하나씩 매칭한다(판정 뜻 그대로).
    const matchedLotIds = 'matchedLotIds' in overrides ? undefined : await defaultMatchedLotIds(prisma, requestId);
    return (await postResult(resultBody(requestId, { matchedLotIds, ...overrides })).expect(201)).body as ResultRow;
  }

  async function versionOf(requestId: number): Promise<number> {
    return (await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } })).version_no;
  }

  async function confirm(requestId: number): Promise<request.Response> {
    return request(app.getHttpServer()).post(`${REQUESTS}/${String(requestId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: await versionOf(requestId) }).expect(200);
  }

  async function cancel(requestId: number, status: number, body: Record<string, unknown> = {}, as = cookie): Promise<request.Response> {
    return request(app.getHttpServer()).post(`${REQUESTS}/${String(requestId)}:cancel-confirm`).set('Cookie', as)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: await versionOf(requestId), ...body }).expect(status);
  }

  async function rejectedAlerts(iqc: IqcLot): Promise<number> {
    return prisma.notification_event.count({ where: { event_type_code: 'IQC_INSPECTION_REJECTED', aggregate_type_code: 'LOT', aggregate_id: { in: lotIdsOf(iqc) } } });
  }

  async function receiveGoods(lotId: number): Promise<void> {
    seq += 1;
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) } });
    const receipt = await prisma.goods_receipt.create({
      data: { goods_receipt_no: `${PREFIX}-GR-${String(seq)}`, receipt_type_code: 'MATERIAL', plant_id: ids.plant, warehouse_id: ids.warehouse,
        receipt_datetime: new Date(), status_code: 'POSTED' },
    });
    await prisma.goods_receipt_line.create({
      data: { goods_receipt_id: receipt.goods_receipt_id, line_no: 1, item_id: lot.item_id, lot_id: lot.lot_id, receipt_qty: lot.initial_qty,
        uom_id: lot.uom_id, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: ids.location },
    });
  }

  async function concession(nonconformanceId: bigint, lotId: bigint): Promise<void> {
    seq += 1;
    const approval = await prisma.approval_request.create({
      data: { approval_request_no: `${PREFIX}-AR${String(seq)}`, approval_type_code: 'CONCESSION', target_type_code: 'NONCONFORMANCE', target_id: nonconformanceId,
        requested_by: ids.user, requested_at: new Date(), status_code: 'PENDING', reason: '특채' },
    });
    await prisma.concession.create({
      data: { concession_no: `${PREFIX}-CN${String(seq)}`, nonconformance_id: nonconformanceId, lot_id: lotId, approved_qty: 10, uom_id: ids.ea,
        valid_from: new Date(), approval_request_id: approval.approval_request_id, status_code: 'PENDING' },
    });
  }

  async function requestStatus(requestId: number): Promise<string> {
    return (await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } })).status_code;
  }

  function lotIdsOf(iqc: IqcLot): bigint[] {
    return iqc.lots.map((lot) => BigInt(lot.lotId));
  }

  async function lotStatuses(iqc: IqcLot): Promise<string[]> {
    const lots = await prisma.lot.findMany({ where: { inbound_lot_id: BigInt(iqc.inboundLotId) }, orderBy: { lot_no: 'asc' } });
    return lots.map((lot) => lot.status_code);
  }

  async function openInspectionHolds(iqc: IqcLot): Promise<number> {
    return prisma.lot_hold.count({ where: { lot_id: { in: lotIdsOf(iqc) }, reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null } });
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '확정취소법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '확정취소사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '확정취소공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '확정취소자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '확정취소창고',
        warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.location = (await prisma.location.create({
      data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-L1`, location_name: '확정취소위치' },
    })).location_id;
  }

  async function makeUser(suffix: string, permissions: string[], workerNo: string): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `${PREFIX} ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    if (workerNo === WORKER_NO) ids.user = user.app_user_id;
    await prisma.worker.create({
      data: { worker_no: workerNo, worker_name: `확정취소검사자 ${suffix}`, business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
    });
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
         OR (aggregate_type_code = 'LOT' AND aggregate_id IN (${lots}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.defect_record WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.concession WHERE concession_no LIKE '${PREFIX}%'`,
      `DELETE FROM app.approval_request WHERE approval_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (${items}))`,
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
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
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
