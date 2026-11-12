/**
 * 피처 005 S9 — 입하 LOT IQC 판정 확정(검사 단위 · T068 · omf-all-around#254).
 * `POST /quality/inspection-requests/{id}:confirm`(W-01-15): 결과 전부 확정·종합 판정(불합격 > 보류 > 합격)·LOT 전부 이동·불합격 부적합 1건.
 * 새 흐름 결과 단위 `:confirm` 은 409(D11-1), 이전된 옛 요청은 결과 단위 확정 그대로(R18-1). 응답은 ajv 로 계약 대조.
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
  IssuedMaterialLot, InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'IQCF';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';
const CONFIRM_PATH = '/quality/inspection-requests/{inspectionRequestId}:confirm';

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

describe('피처 005 S9 입하 LOT IQC 판정 확정 (e2e)', () => {
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

  it('US4-1·SC-004 모두 합격 → 결과 전부 확정·요청 완료·LOT 전부 정상(C4, 원천 INSPECTION_REQUEST)·검사 대기 보류 해제·이력 CONFIRMED', async () => {
    const iqc = await iqcLot(3);
    const first = await addResult(iqc.requestId, { matchedLotIds: [iqc.lots[0].lotId] });
    const second = await addResult(iqc.requestId);
    const response = await confirm(iqc.requestId, 200);
    expectShape(schemaOf(CONFIRM_PATH, 'post', 200), response.body);
    expect(response.body).toMatchObject({
      statusCode: 'COMPLETED', overallJudgmentCode: 'ACCEPTED', confirmedByName: `${PREFIX} ALL`, nonconformanceId: null, previewJudgmentCode: 'ACCEPTED',
    });
    expect((response.body.results as { statusCode: string }[]).map((row) => row.statusCode)).toEqual(['CONFIRMED', 'CONFIRMED']);

    const row = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } });
    expect(row).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED', confirmed_by: ids.user });
    expect(row.confirmed_at).not.toBeNull();
    for (const result of [first, second]) {
      const stored = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(result.inspectionResultId) } });
      expect(stored.status_code).toBe('CONFIRMED');
      expect(stored.confirmed_at).toEqual(row.confirmed_at);
    }
    expect(await lotStatuses(iqc)).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
    expect(await openInspectionHolds(iqc)).toBe(0);
    const events = await prisma.lot_status_event.findMany({ where: { lot_id: { in: lotIdsOf(iqc) }, transition_code: 'C4' } });
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.source_document_type_code === 'INSPECTION_REQUEST' && event.source_document_id === BigInt(iqc.requestId))).toBe(true);
    expect(await eventCodes(iqc.requestId)).toEqual(['RESULT_ADDED', 'RESULT_ADDED', 'CONFIRMED']);
  });

  it('US4-1 다른 열린 보류가 남은 LOT 은 합격이어도 옮기지 않는다 — 검사 대기 보류만 닫힌다', async () => {
    const iqc = await iqcLot(2);
    await prisma.lot_hold.create({
      data: { lot_id: BigInt(iqc.lots[1].lotId), reason_code: 'SUSPECT', status_code: 'HELD', held_by: ids.user, held_at: new Date() },
    });
    await addResult(iqc.requestId);
    await confirm(iqc.requestId, 200);
    expect(await lotStatuses(iqc)).toEqual(['NORMAL', 'INSPECTION_PENDING']);
    expect(await openInspectionHolds(iqc)).toBe(0);
  });

  it('US4-2·SC-004 불합격 1건 → LOT 전부 불량(C6)·부적합 1건(LOT 전부·초기 수량·첫 불합격 결과·요청)·불합격 알림 입하 LOT 당 1회', async () => {
    const iqc = await iqcLot(3);
    await addResult(iqc.requestId);
    const rejected = await addResult(iqc.requestId, { acceptedQty: 7, rejectedQty: 3, overallJudgmentCode: 'REJECTED' });
    await addResult(iqc.requestId, { acceptedQty: 8, rejectedQty: 2, overallJudgmentCode: 'REJECTED' });
    const response = await confirm(iqc.requestId, 200);
    expectShape(schemaOf(CONFIRM_PATH, 'post', 200), response.body);
    expect(response.body).toMatchObject({ overallJudgmentCode: 'REJECTED' });
    expect(await lotStatuses(iqc)).toEqual(['DEFECTIVE', 'DEFECTIVE', 'DEFECTIVE']);
    expect(await openInspectionHolds(iqc)).toBe(3);

    const nonconformances = await prisma.nonconformance.findMany({ where: { inspection_request_id: BigInt(iqc.requestId) }, include: { nonconformance_lot: true } });
    expect(nonconformances).toHaveLength(1);
    const [nc] = nonconformances;
    expect(response.body.nonconformanceId).toBe(Number(nc.nonconformance_id));
    expect(nc).toMatchObject({ status_code: 'PENDING_DECISION', inspection_result_id: BigInt(rejected.inspectionResultId) });
    expect(nc.nonconformance_lot.map((line) => [Number(line.lot_id), Number(line.affected_qty)]).sort()).toEqual(iqc.lots.map((lot) => [lot.lotId, lot.lotQty]).sort());
    const alerts = await prisma.notification_event.count({
      where: { event_type_code: 'IQC_INSPECTION_REJECTED', aggregate_type_code: 'LOT', aggregate_id: { in: lotIdsOf(iqc) } },
    });
    expect(alerts).toBe(1);
  });

  it('US4-3 보류(불합격 없음) → LOT 전부 검사 대기 그대로(C5)·보류 유지·부적합 없음', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId);
    await addResult(iqc.requestId, { acceptedQty: 5, heldQty: 5, overallJudgmentCode: 'HELD' });
    const response = await confirm(iqc.requestId, 200);
    expect(response.body).toMatchObject({ overallJudgmentCode: 'HELD', nonconformanceId: null });
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING', 'INSPECTION_PENDING']);
    expect(await openInspectionHolds(iqc)).toBe(2);
    expect(await prisma.lot_status_event.count({ where: { lot_id: { in: lotIdsOf(iqc) }, transition_code: 'C5' } })).toBe(2);
    expect(await prisma.nonconformance.count({ where: { inspection_request_id: BigInt(iqc.requestId) } })).toBe(0);
  });

  it('US4-5·SC-005 확정 뒤 결과 추가·수정·삭제는 409 「판정 확정」 — 결과는 그대로', async () => {
    const iqc = await iqcLot(1);
    const created = await addResult(iqc.requestId);
    await confirm(iqc.requestId, 200);
    const stored = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(created.inspectionResultId) } });
    const added = await postResult(resultBody(iqc.requestId)).expect(409);
    expect(added.body).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('판정 확정') as string });
    await request(app.getHttpServer()).put(`${RESULTS}/${String(created.inspectionResultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(stored.version_no)}"`).send({ remarks: '확정 뒤' }).expect(409);
    await request(app.getHttpServer()).delete(`${RESULTS}/${String(created.inspectionResultId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(stored.version_no)}"`).expect(409);
    const after = await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(created.inspectionResultId) } });
    expect(after).toMatchObject({ status_code: 'CONFIRMED', version_no: stored.version_no, remarks: stored.remarks });
    expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(iqc.requestId) } })).toBe(1);
  });

  it('US4-6 결과 0건·판정이 빈 결과·수량 합이 틀린 결과는 400 — 요청·LOT 그대로', async () => {
    const empty = await iqcLot(1);
    const none = await confirm(empty.requestId, 400);
    expect(none.body.errors).toEqual([expect.objectContaining({ field: 'results', code: 'REQUIRED' })]);

    const iqc = await iqcLot(1);
    await addResult(iqc.requestId);
    await addResult(iqc.requestId, { overallJudgmentCode: undefined });
    await addResult(iqc.requestId, { acceptedQty: 4 });
    const invalid = await confirm(iqc.requestId, 400);
    expect(invalid.body.errors).toEqual([
      expect.objectContaining({ field: 'results[2].overallJudgmentCode', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'results[3].inspectedQty', code: 'INVALID' }),
    ]);
    expect(await requestStatus(iqc.requestId)).toBe('IN_PROGRESS');
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING']);
  });

  it('US4-7·R19-1·SC-005 W-01-15 가 없으면 결과 기록은 되고 :confirm·:cancel-confirm 은 403', async () => {
    const iqc = await iqcLot(1);
    await postResult(resultBody(iqc.requestId), recorder).expect(201);
    await confirm(iqc.requestId, 403, recorder);
    await request(app.getHttpServer()).post(`${REQUESTS}/${String(iqc.requestId)}:cancel-confirm`).set('Cookie', recorder)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: await versionOf(iqc.requestId) }).expect(403);
    expect(await requestStatus(iqc.requestId)).toBe('IN_PROGRESS');
  });

  it('R12-1 4M 은 자재 관리 LOT 전부에(LOT 당 1행) 남고 검사 수준은 확정 때 한 번 기록된다', async () => {
    const iqc = await iqcLot(3);
    await addResult(iqc.requestId, { fourMChange: { remarks: '공급사 설비 변경' } });
    await addResult(iqc.requestId);
    await confirm(iqc.requestId, 200);
    const rows = await prisma.lot_four_m_change.findMany({ where: { lot_id: { in: lotIdsOf(iqc) } } });
    expect(rows.map((row) => row.lot_id).sort()).toEqual(lotIdsOf(iqc).sort());
    expect(rows.every((row) => row.inspection_request_id === BigInt(iqc.requestId) && row.remarks === '공급사 설비 변경')).toBe(true);
    expect((await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) } })).inspection_level_code).toBe('NORMAL');
  });

  it('US4-2 이미 열린 부적합이 있는 LOT 은 빼고 담는다(옛 데이터 안전장치)', async () => {
    const iqc = await iqcLot(3);
    const open = await prisma.nonconformance.create({
      data: { nonconformance_no: `${PREFIX}-NC-OLD`, item_id: ids.item, severity_code: 'MAJOR', description: '옛 부적합', status_code: 'PENDING_DECISION', opened_at: new Date() },
    });
    await prisma.nonconformance_lot.create({
      data: { nonconformance_id: open.nonconformance_id, lot_id: BigInt(iqc.lots[0].lotId), affected_qty: 10, uom_id: ids.ea,
        quality_status_before_code: 'INSPECTION_PENDING', quality_status_after_code: 'INSPECTION_PENDING' },
    });
    await addResult(iqc.requestId, { acceptedQty: 0, rejectedQty: 10, overallJudgmentCode: 'REJECTED' });
    await confirm(iqc.requestId, 200);
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(iqc.requestId) }, include: { nonconformance_lot: true } });
    expect(nc.nonconformance_lot.map((line) => Number(line.lot_id)).sort()).toEqual([iqc.lots[1].lotId, iqc.lots[2].lotId].sort());
  });

  it('SC-005 동시 확정 — 하나만 200, 뒤는 409 VERSION_CONFLICT · LOT 은 한 번만 옮겨진다', async () => {
    const iqc = await iqcLot(2);
    await addResult(iqc.requestId);
    const version = await versionOf(iqc.requestId);
    const responses = await Promise.all([confirm(iqc.requestId, undefined, cookie, version), confirm(iqc.requestId, undefined, cookie, version)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await prisma.lot_status_event.count({ where: { lot_id: { in: lotIdsOf(iqc) }, transition_code: 'C4' } })).toBe(2);
  });

  it('US4-1 LOT 50개 입하 LOT 확정이 2초 안', async () => {
    const iqc = await iqcLot(50);
    await addResult(iqc.requestId, { inspectedQty: 50, acceptedQty: 50 });
    const started = Date.now();
    await confirm(iqc.requestId, 200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(new Set(await lotStatuses(iqc))).toEqual(new Set(['NORMAL']));
  }, 120_000);

  it('D11-1 새 흐름 IQC 결과 단위 :confirm 은 409 「검사 단위로 확정하세요」 — 결과·LOT 그대로', async () => {
    const iqc = await iqcLot(1);
    const created = await addResult(iqc.requestId);
    const response = await request(app.getHttpServer()).post(`${RESULTS}/${String(created.inspectionResultId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(created.versionNo)}"`).send({ overallJudgmentCode: 'ACCEPTED' }).expect(409);
    expectShape(schemaOf('/quality/inspection-results/{inspectionResultId}:confirm', 'post', 409), response.body);
    expect(response.body).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('검사 단위로 확정하세요') as string });
    expect((await prisma.inspection_result.findUniqueOrThrow({ where: { inspection_result_id: BigInt(created.inspectionResultId) } })).status_code).toBe('DRAFT');
    expect(await lotStatuses(iqc)).toEqual(['INSPECTION_PENDING']);
  });

  it('R18-1·D11-1 이전된 옛 요청(대상 LOT)은 S9 뒤에도 회차 사슬·결과 단위 확정 그대로 — 요청 :confirm 은 409', async () => {
    const legacy = await legacyIqc(5);
    const first = (await postResult(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5 })).expect(201)).body as ResultRow;
    const second = (await postResult(resultBody(legacy.requestId, { inspectedQty: 5, acceptedQty: 5, previousResultId: first.inspectionResultId })).expect(201)).body as ResultRow;
    const refused = await confirm(legacy.requestId, 409);
    expectShape(schemaOf(CONFIRM_PATH, 'post', 409), refused.body);
    expect(refused.body).toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('이전 데이터 검사는 결과 단위로 확정합니다') as string });
    await request(app.getHttpServer()).post(`${RESULTS}/${String(second.inspectionResultId)}:confirm`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(second.versionNo)}"`).send({ overallJudgmentCode: 'ACCEPTED' }).expect(200);
    const confirmed = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(legacy.requestId) } });
    expect(confirmed).toMatchObject({ status_code: 'COMPLETED', overall_judgment_code: 'ACCEPTED', confirmed_by: ids.user });
    expect(confirmed.confirmed_at).not.toBeNull();
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(legacy.lotId) } })).status_code).toBe('NORMAL');
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
    return (await postResult(resultBody(requestId, overrides)).expect(201)).body as ResultRow;
  }

  async function versionOf(requestId: number): Promise<number> {
    return (await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } })).version_no;
  }

  async function confirm(requestId: number, status?: number, as = cookie, version?: number): Promise<request.Response> {
    const versionNo = version ?? await versionOf(requestId);
    const sent = request(app.getHttpServer()).post(`${REQUESTS}/${String(requestId)}:confirm`).set('Cookie', as)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo });
    return status === undefined ? sent : sent.expect(status);
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

  async function eventCodes(requestId: number): Promise<string[]> {
    const rows = await prisma.inspection_request_event.findMany({
      where: { inspection_request_id: BigInt(requestId) }, orderBy: { inspection_request_event_id: 'asc' }, select: { event_type_code: true },
    });
    return rows.map((row) => row.event_type_code);
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '판정확정법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '판정확정사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '판정확정공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '판정확정자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    await prisma.item_inspection_level.create({ data: { item_id: ids.item, inspection_level_code: 'NORMAL', auto_switch_enabled: false } });
  }

  async function makeUser(suffix: string, permissions: string[], workerNo: string): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `${PREFIX} ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    if (workerNo === WORKER_NO) ids.user = user.app_user_id;
    await prisma.worker.create({
      data: { worker_no: workerNo, worker_name: `판정확정검사자 ${suffix}`, business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
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
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM quality.item_inspection_level WHERE item_id IN (${items})`,
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
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
