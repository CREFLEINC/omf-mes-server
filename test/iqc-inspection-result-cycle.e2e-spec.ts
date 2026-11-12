/**
 * 피처 005 S10 — W-03-05 검사 결과 행의 확정 주기(T126 · D-18 · omf-all-around#254).
 * `GET /quality/inspection-results` 의 입하 LOT IQC 결과 행에 `confirmCycle`(처음 1 · 확정 취소 뒤 2 · 재작업 재열기 뒤 3),
 * `finalRoundOnly=true` 는 요청의 마지막 주기 결과만. 옛 IQC(회차 사슬)는 `confirmCycle` null·지금 결과 그대로.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020';
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
import { InboundLotFixture, closeInboundLotFixture, idempotencyKey, issueAndReceive, sessionAuth, terminalAuth } from './support/inbound-lot-fixture';

const PREFIX = 'IQCY';
const TZ = 'Asia/Ho_Chi_Minh';
const DAY = localDate(new Date(), TZ);
const WORKER_NO = `${PREFIX}-W1`;
const RESULTS = '/api/quality/inspection-results';
const REQUESTS = '/api/quality/inspection-requests';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object, 'quality');
const validateList = ajv.compile({ $ref: 'quality#/paths/~1quality~1inspection-results/get/responses/200/content/application~1json/schema' });

interface ResultLine { inspectionResultId: number; inspectionRound: number; confirmCycle?: number | null; previousResultId?: number }

describe('피처 005 S10 W-03-05 결과 행 확정 주기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
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
    cookie = await makeUser();
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: DAY, keys, inspector: sessionAuth(cookie), prisma,
    };
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('D18-1 입하 LOT IQC 결과 행 confirmCycle — 처음 결과 1, 확정 취소 뒤 더한 결과 2, 재작업 재열기 뒤 3 · finalRoundOnly 는 마지막 주기만', async () => {
    const { inboundLot } = await issueAndReceive(fx, { plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.item), lotQty: 10, lotCount: 2 });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const requestId = closed.iqcRequestId as number;

    await addResult(requestId, 'REJECTED');
    await post(`${REQUESTS}/${String(requestId)}:confirm`, { versionNo: await versionOf(requestId) });
    await post(`${REQUESTS}/${String(requestId)}:cancel-confirm`, { versionNo: await versionOf(requestId) });
    await addResult(requestId, 'REJECTED');
    await post(`${REQUESTS}/${String(requestId)}:confirm`, { versionNo: await versionOf(requestId) });
    const nc = await prisma.nonconformance.findFirstOrThrow({ where: { inspection_request_id: BigInt(requestId), status_code: 'PENDING_DECISION' } });
    await request(app.getHttpServer()).post(`/api/quality/nonconformances/${String(nc.nonconformance_id)}/disposition-decisions`)
      .set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).set('If-Match', `W/"${String(nc.version_no)}"`)
      .send({ dispositionTypeCode: 'REWORK', decisionQty: 20, uomId: Number(ids.ea), reason: '재작업' }).expect(201);
    const last = await addResult(requestId, 'ACCEPTED');
    await post(`${REQUESTS}/${String(requestId)}:confirm`, { versionNo: await versionOf(requestId) });

    const all = await list({ inspectionRequestId: String(requestId) });
    expect(all.map((row) => [row.inspectionRound, row.confirmCycle])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(all.every((row) => row.previousResultId === undefined)).toBe(true);
    const final = await list({ inspectionRequestId: String(requestId), finalRoundOnly: 'true' });
    expect(final.map((row) => [row.inspectionResultId, row.confirmCycle])).toEqual([[last, 3]]);
  });

  it('D18-1 옛 IQC(대상 LOT · 회차 사슬) 결과 행은 confirmCycle null — 지금 결과 그대로', async () => {
    const legacy = await legacyIqc();
    const first = await addResult(legacy, 'ACCEPTED');

    const rows = await list({ inspectionRequestId: String(legacy) });
    expect(rows).toEqual([expect.objectContaining({ inspectionResultId: first, inspectionRound: 1, confirmCycle: null })]);
    const final = await list({ inspectionRequestId: String(legacy), finalRoundOnly: 'true' });
    expect(final.map((row) => [row.inspectionResultId, row.confirmCycle])).toEqual([[first, null]]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(query: Record<string, string>): Promise<ResultLine[]> {
    const response = await request(app.getHttpServer()).get(RESULTS).query(query).set('Cookie', cookie).expect(200);
    validateList(response.body);
    expect(validateList.errors ?? []).toEqual([]);
    return response.body.items as ResultLine[];
  }

  async function addResult(requestId: number, judgment: 'ACCEPTED' | 'REJECTED'): Promise<number> {
    const rejected = judgment === 'REJECTED' ? 20 : 0;
    const response = await post(RESULTS, {
      inspectionRequestId: requestId, inspectedQty: 20, acceptedQty: 20 - rejected, rejectedQty: rejected, heldQty: 0, uomId: Number(ids.ea),
      inspectedAt: `${DAY}T06:00:00.000Z`, statusCode: 'DRAFT', overallJudgmentCode: judgment,
    }, 201);
    return response.body.inspectionResultId as number;
  }

  function post(path: string, body: Record<string, unknown>, status = 200): Promise<request.Response> {
    return request(app.getHttpServer()).post(path).set('Cookie', cookie).set('Idempotency-Key', idempotencyKey(fx)).send(body).expect(status).then((response) => response);
  }

  async function versionOf(requestId: number): Promise<number> {
    return (await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } })).version_no;
  }

  /** 이전된 옛 IQC 요청 — 대상 LOT·`lot_id` 있음(데이터 이전 3). */
  async function legacyIqc(): Promise<number> {
    seq += 1;
    const at = new Date(`${DAY}T02:00:00.000Z`);
    const receipt = await prisma.inbound_receipt.create({
      data: { inbound_receipt_no: `${PREFIX}-IR-L${String(seq)}`, supplier_id: ids.supplier, plant_id: ids.plant, receipt_datetime: at, status_code: 'REGISTERED' },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: { inbound_receipt_id: receipt.inbound_receipt_id, line_no: 1, item_id: ids.item, received_qty: 20, uom_id: ids.ea,
        supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED' },
    });
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-LEGACY-${String(seq)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 20, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: 'INSPECTION_PENDING' },
    });
    const iqc = await prisma.inspection_request.create({
      data: { inspection_request_no: `${PREFIX}-IQC-L${String(seq)}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lot.lot_id,
        item_id: ids.item, lot_id: lot.lot_id, target_qty: 20, uom_id: ids.ea, status_code: 'REQUESTED', requested_at: at },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return Number(iqc.inspection_request_id);
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant) });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '확정주기법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '확정주기사업부' },
    })).business_unit_id;
    ids.plant = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P`, plant_name: '확정주기공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '확정주기자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
  }

  async function makeUser(): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-ALL`, user_name: `${PREFIX} ALL`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_ALL`, role_name: `${PREFIX} ALL` } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission) => ({ role_id: role.role_id, permission_code: permission.code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    await prisma.worker.create({
      data: { worker_no: WORKER_NO, worker_name: '확정주기 검사자', business_unit_id: ids.unit, plant_id: ids.plant, app_user_id: user.app_user_id, status_code: 'EMPLOYED' },
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
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_measurement WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.lot_four_m_change WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
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
