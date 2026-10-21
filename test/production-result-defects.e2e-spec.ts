/**
 * POP 생산 실적의 불량 유형 — 양품과 불량을 한 번에 저장하면 유형별 불량 기록(원천 FIELD)이 실적과 함께 남는다(장부 P-95) (e2e).
 *
 * 불량 코드는 W/O 공정에 `defect_code_process` 로 매핑된 상세 코드만 받는다. `GET /quality/defect-codes?processId=` 가 같은 기준이다.
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
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
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'PRDEF';
const RESULTS = '/api/production/production-results';
const OCCURRED_AT = '2026-10-21T02:00:00.000Z';
/** 관리웹 조회 계정 — 실적 조회는 단말 범위 밖이고 403 을 선언하지 않아 역할 없이 읽는다. */
const LOGIN_ID = 'e2e-prdef-viewer';
const PASSWORD = 'PRDEF-불량실적-비밀번호';

function validator(file: string, operation: string, status: number): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, `../contracts/${file}`), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('POP 생산 실적 불량 유형 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let workerNo: string;
  let cookie: string[];
  const keys: string[] = [];
  const ids = {
    uom: 0n, worker: 0n, terminal: 0n, process: 0n, otherProcess: 0n, workOrder: 0n, equipment: 0n,
    parent: 0n, scratch: 0n, dent: 0n, otherProcessCode: 0n, session: 0n, mold: 0n,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixture();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 양품과 불량 유형 둘을 한 번에 저장하면 실적 불량수량과 유형별 불량 기록이 함께 남는다', async () => {
    const response = await record({
      goodQty: 10,
      equipmentId: Number(ids.equipment),
      defects: [
        { defectCodeId: Number(ids.scratch), qty: 2 },
        { defectCodeId: Number(ids.dent), qty: 1 },
      ],
    }).expect(201);

    expect(validator('production-02생산실행.json', 'POST /production/production-results', 201)(response.body)).toBe(true);
    expect(response.body).toMatchObject({ goodQty: 10, defectQty: 3 });
    expect(response.body.defects).toEqual([
      expect.objectContaining({
        defectCodeId: Number(ids.scratch), defectCode: `${PREFIX}-SCR`, defectName: '긁힘', nameVi: '긁힘-vi', qty: 2,
        parentDefectCodeId: Number(ids.parent), parentDefectCode: `${PREFIX}-APP`, parentDefectName: '외관', parentNameVi: '외관-vi',
      }),
      expect.objectContaining({ defectCodeId: Number(ids.dent), qty: 1 }),
    ]);
    const rows = await prisma.defect_record.findMany({
      where: { production_result_id: BigInt(response.body.productionResultId) },
      orderBy: { defect_record_id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        source_type_code: 'FIELD', work_order_id: ids.workOrder, lot_id: null,
        occurrence_process_id: ids.process, detection_process_id: ids.process,
        worker_id: ids.worker, equipment_id: ids.equipment, mold_id: null, uom_id: ids.uom,
        detected_at: new Date(OCCURRED_AT), created_by: null,
      });
    }
  });

  it('세션을 실은 실적이 설비를 생략하면 불량 기록은 세션의 설비·금형을 쓴다 — 실적 행은 그대로 비운다', async () => {
    const response = await record({
      goodQty: 3, workSessionId: Number(ids.session), defects: [{ defectCodeId: Number(ids.scratch), qty: 1 }],
    }).expect(201);

    const resultId = BigInt(response.body.productionResultId);
    expect(await prisma.production_result.findUniqueOrThrow({ where: { production_result_id: resultId } }))
      .toMatchObject({ equipment_id: null, mold_id: null });
    expect(await prisma.defect_record.findFirstOrThrow({ where: { production_result_id: resultId } }))
      .toMatchObject({ equipment_id: ids.equipment, mold_id: ids.mold });
  });

  it('⭐ 양품 0 · 불량만 있는 실적을 받는다', async () => {
    const response = await record({ goodQty: 0, defects: [{ defectCodeId: Number(ids.scratch), qty: 4 }] }).expect(201);

    expect(response.body).toMatchObject({ goodQty: 0, defectQty: 4 });
    expect(response.body.defects).toHaveLength(1);
  });

  it('불량수량만 오면 기록 없이 수량만 남는다 — 응답 defects 는 빈 배열', async () => {
    const response = await record({ goodQty: 1, defectQty: 2 }).expect(201);

    expect(response.body).toMatchObject({ defectQty: 2, defects: [] });
  });

  it('⛔ 매핑되지 않은 코드·대분류·합 불일치는 400 이고 실적도 불량 기록도 남지 않는다', async () => {
    const before = await counts();

    const unmapped = await record({ goodQty: 1, defects: [{ defectCodeId: Number(ids.otherProcessCode), qty: 1 }] }).expect(400);
    expect(unmapped.body.errors[0]).toMatchObject({ field: 'defects[0].defectCodeId', code: 'INVALID' });
    const parent = await record({ goodQty: 1, defects: [{ defectCodeId: Number(ids.parent), qty: 1 }] }).expect(400);
    expect(parent.body.errors[0]).toMatchObject({ field: 'defects[0].defectCodeId', code: 'INVALID' });
    const mismatch = await record({ goodQty: 1, defectQty: 5, defects: [{ defectCodeId: Number(ids.scratch), qty: 1 }] }).expect(400);
    expect(mismatch.body.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });

    expect(await counts()).toEqual(before);
  });

  it('단건·목록 조회가 defects(코드·이름·수량)를 싣는다', async () => {
    const created = await record({ goodQty: 5, defects: [{ defectCodeId: Number(ids.dent), qty: 1 }] }).expect(201);
    const resultId = created.body.productionResultId as number;

    const detail = await request(app.getHttpServer()).get(`${RESULTS}/${resultId}`).set('Cookie', cookie).expect(200);
    expect(detail.body.defects).toEqual([
      expect.objectContaining({ defectCodeId: Number(ids.dent), defectCode: `${PREFIX}-DNT`, defectName: '찍힘', qty: 1 }),
    ]);
    const list = await request(app.getHttpServer())
      .get(`${RESULTS}?workOrderId=${String(ids.workOrder)}&size=100`)
      .set('Cookie', cookie)
      .expect(200);
    const item = list.body.items.find((row: { productionResultId: number }) => row.productionResultId === resultId);
    expect(item.defects).toEqual(detail.body.defects);
  });

  it('같은 멱등 키 재전송이 불량 기록을 두 번 남기지 않는다', async () => {
    const key = newKey();
    const body = { goodQty: 2, defects: [{ defectCodeId: Number(ids.scratch), qty: 1 }] };
    const first = await record(body, key).expect(201);
    const second = await record(body, key);

    expect(second.body.productionResultId).toBe(first.body.productionResultId);
    expect(await prisma.defect_record.count({ where: { production_result_id: BigInt(first.body.productionResultId) } })).toBe(1);
  });

  it('GET /quality/defect-codes?processId= 는 그 공정에 매핑된 상세와 그 대분류 행만 내린다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes?processId=${String(ids.process)}&size=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const codes = response.body.items.map((row: { defectCode: string }) => row.defectCode).sort();
    // 다른 공정에만 매핑된 상세와, 고를 상세가 없는 대분류는 빠진다. 비활성 대분류 APP 은 실린 상세가 있어 나온다.
    expect(codes).toEqual([`${PREFIX}-APP`, `${PREFIX}-DNT`, `${PREFIX}-SCR`]);
    const parent = response.body.items.find((row: { defectCode: string }) => row.defectCode === `${PREFIX}-APP`);
    expect(parent.parentDefectCodeId).toBeNull();
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function record(body: Record<string, unknown>, key = newKey()): request.Test {
    return asPop(request(app.getHttpServer()).post(RESULTS).set('Idempotency-Key', key)).send({
      workOrderId: Number(ids.workOrder), uomId: Number(ids.uom), resultSourceCode: 'MANUAL', occurredAt: OCCURRED_AT, ...body,
    });
  }

  function asPop(test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${token}`).set('X-Worker-No', workerNo);
  }

  function newKey(): string {
    const value = randomUUID();
    keys.push(value);
    return value;
  }

  async function counts(): Promise<{ results: number; defects: number }> {
    const where = { work_order_id: ids.workOrder };
    return { results: await prisma.production_result.count({ where }), defects: await prisma.defect_record.count({ where }) };
  }

  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '실적불량법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '실적불량사업부',
    } });
    const plant = await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P1`, plant_name: '실적불량공장', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: '실적불량품목', item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id,
    } });
    ids.process = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '실적불량사출', process_type_code: 'PRODUCTION' } })).process_id;
    ids.otherProcess = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR2`, process_name: '실적불량조립', process_type_code: 'PRODUCTION' } })).process_id;

    const code = async (suffix: string, name: string, parentId: bigint | null) => (await prisma.defect_code.create({ data: {
      defect_code: `${PREFIX}-${suffix}`, defect_name: name, name_vi: `${name}-vi`, parent_defect_code_id: parentId,
    } })).defect_code_id;
    ids.parent = await code('APP', '외관', null);
    // 대분류는 묶음 머리라 비활성이어도 실린 상세가 있으면 조회에 나온다.
    await prisma.defect_code.update({ where: { defect_code_id: ids.parent }, data: { is_active: false } });
    ids.scratch = await code('SCR', '긁힘', ids.parent);
    ids.dent = await code('DNT', '찍힘', ids.parent);
    ids.otherProcessCode = await code('BRK', '파손', ids.parent);
    // 자기는 이 공정에 매핑됐지만 상세가 다른 공정에만 매핑된 대분류 — 고를 상세가 없어 조회에서 빠진다.
    const otherParent = await code('STR', '구조', null);
    const crack = await code('CRK', '균열', otherParent);
    await prisma.defect_code_process.createMany({ data: [
      { defect_code_id: ids.parent, process_id: ids.process },
      { defect_code_id: ids.scratch, process_id: ids.process },
      { defect_code_id: ids.dent, process_id: ids.process },
      { defect_code_id: ids.otherProcessCode, process_id: ids.otherProcess },
      { defect_code_id: otherParent, process_id: ids.process },
      { defect_code_id: crack, process_id: ids.otherProcess },
    ] });

    const terminal = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING',
    } });
    ids.terminal = terminal.terminal_id;
    // 단말이 실적을 받으려면 W/O 공정에서 작업을 시작할 수 있어야 한다(`terminal-production-scope.ts`).
    await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: ids.process, can_start_work: true } });
    const worker = await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: '실적불량작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED',
    } });
    ids.worker = worker.worker_id;
    workerNo = worker.worker_no;
    token = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(plant.plant_id),
    });

    const line = await prisma.production_line.create({ data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LINE`, line_name: '실적불량라인' } });
    ids.equipment = (await prisma.equipment.create({ data: {
      plant_id: plant.plant_id, production_line_id: line.production_line_id, equipment_code: `${PREFIX}-EQ`, equipment_name: '실적불량설비',
      equipment_type_code: 'PRESS', status_code: 'IN_SERVICE',
    } })).equipment_id;
    const routing = await prisma.routing.create({ data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: ids.process, operation_name: '실적불량작업',
    } });
    ids.workOrder = (await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: item.item_id,
      order_qty: 100, uom_id: uom.uom_id, status_code: 'RELEASED', production_line_id: line.production_line_id,
      released_at: new Date(OCCURRED_AT),
    } })).work_order_id;
    ids.mold = (await prisma.mold.create({ data: {
      plant_id: plant.plant_id, mold_code: `${PREFIX}-MOLD`, mold_name: '실적불량금형', status_code: 'ACTIVE', tool_type_code: 'MOLD',
    } })).mold_id;
    // 설비·금형을 건 세션 — 본문에 설비를 생략한 실적의 불량 기록이 이 값을 쓴다.
    ids.session = (await prisma.work_session.create({ data: {
      work_order_id: ids.workOrder, session_no: 1, equipment_id: ids.equipment, mold_id: ids.mold, terminal_id: terminal.terminal_id,
      started_at: new Date('2026-10-21T01:00:00.000Z'), status_code: 'IN_PROGRESS', idempotency_key: `${PREFIX}-WS-1`,
    } })).work_session_id;

    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '실적불량조회', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const session = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = session.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({ where: { idempotency_key: { in: keys } } });
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    // ⛔ 단말 쓰기는 감사 행을 남기고 그 행이 단말을 FK 로 문다 — 단말보다 먼저 지운다.
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM quality.defect_record WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_session WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.mold WHERE mold_code LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.equipment WHERE equipment_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.production_line WHERE line_code LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code_process WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.defect_code WHERE defect_code LIKE '${PREFIX}%' AND parent_defect_code_id IS NOT NULL`,
      `DELETE FROM quality.defect_code WHERE defect_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
