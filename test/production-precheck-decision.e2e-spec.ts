/**
 * 작업 전 점검 통제 판정 조회 1건 `GET /production/precheck-decisions`(I-11 PR ①) +
 * 기록 `POST /production/precheck-decisions`(I-11 PR ⑤).
 *
 * ⭐ 조회가 보는 판정 이력(d1~dOther)은 **직접 INSERT** 한다 — 등록 경로를 태우면
 * 조회 단언이 등록 구현에 매달린다. 등록 갈래(PR ⑤)만 API 로 만든다.
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — FK 역순 `DELETE` 로 정리한다(I-9 §7-2).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { parseIfMatch } from '../src/common/optimistic-lock';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-pde-probe';
const NOPERM_ID = 'e2e-pde-noperm';
const PASSWORD = 'PDE-통제판정-비밀번호';
const PREFIX = 'PDE2E';
const ROLE = 'E2E_PRECHECK_DECISION';
/** 계약이 403 을 선언한 유일한 자리 — `derived-permissions.ts:231`. */
const PERMISSIONS = ['P-02-02'];
const BASE = '/api/production/precheck-decisions';

const T0 = '2026-09-07T01:00:00.000Z';
const T1 = '2026-09-07T02:00:00.000Z';
// 직접 INSERT 픽스처(d1~d3)가 T1 까지 쓴다 — 등록 e2e 는 그보다 늦은 시각을 써야
// `decided_at DESC` 정렬에서 확실히 «가장 최근»이 된다.
const T2 = '2026-09-07T03:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('작업 전 점검 통제 판정 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let workOrderAId: number;
  let workOrderEmergencyId: number;
  let equipmentAId: number;
  let equipmentBId: number;
  let d1Id: number;
  let d2Id: number;
  let d3Id: number;
  let dOtherId: number;
  const workerNo = `${PREFIX}-WK`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUsers();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('precheck 목록이 decided_at 내림차순이라 size=1 이 가장 최근 한 건이다', async () => {
    const full = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&equipmentId=${equipmentAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(validator('GET /production/precheck-decisions')(full.body)).toBe(true);
    // d2·d3 는 decided_at 이 같다 — 동률은 PK 내림차순으로 닫는다(§8 ⭐).
    expect(full.body.items.map((item: { precheckDecisionId: number }) => item.precheckDecisionId)).toEqual([
      d3Id,
      d2Id,
      d1Id,
    ]);

    const latest = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&equipmentId=${equipmentAId}&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(latest.body.items).toHaveLength(1);
    expect(latest.body.items[0]).toMatchObject({ precheckDecisionId: d3Id, decisionCode: 'WARNED' });
  });

  it('precheck 목록이 workOrderId·equipmentId·decisionCode 로 걸러진다', async () => {
    const byEquipment = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&equipmentId=${equipmentBId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byEquipment.body.items).toEqual([]);

    const other = await request(app.getHttpServer())
      .get(`${BASE}?equipmentId=${equipmentBId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(other.body.items.map((item: { precheckDecisionId: number }) => item.precheckDecisionId)).toEqual([
      dOtherId,
    ]);

    const blocked = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&decisionCode=BLOCKED`)
      .set('Cookie', cookie)
      .expect(200);
    expect(blocked.body.items.map((item: { precheckDecisionId: number }) => item.precheckDecisionId)).toEqual([
      d2Id,
    ]);
  });

  it('⛔ 조회 응답에 ETag 가 없다', async () => {
    // 계약이 이 오퍼레이션에 헤더를 선언하지 않았다 — `setEtag` 를 부르지 않는다(I-9 ①-1 선례).
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(parseIfMatch(String(response.headers.etag ?? ''))).toBeNull();
  });

  it('PASSED 판정이 201 로 기록되고 목록에 뜬다', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
    }).expect(201);
    expect(validator('POST /production/precheck-decisions', 201)(response.body)).toBe(true);
    expect(response.body).toMatchObject({ workOrderId: workOrderAId, equipmentId: equipmentAId, decisionCode: 'PASSED' });

    const listed = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${workOrderAId}&equipmentId=${equipmentAId}&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(listed.body.items[0]).toMatchObject({ precheckDecisionId: response.body.precheckDecisionId });
  });

  it('⭐ BLOCKED 도 기록된다 — 차단이 남는다', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'BLOCK',
      decisionCode: 'BLOCKED',
    }).expect(201);
    expect(response.body.decisionCode).toBe('BLOCKED');
  });

  it('OVERRIDDEN 인데 긴급 W/O 가 아니면 400 INVALID', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'BLOCK',
      decisionCode: 'OVERRIDDEN',
      overrideReasonCode: 'EMERGENCY_WORK_ORDER',
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'overrideReasonCode', code: 'INVALID' });
  });

  it('OVERRIDDEN 인데 사유가 없으면 400 REQUIRED', async () => {
    const response = await postDecision({
      workOrderId: workOrderEmergencyId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'BLOCK',
      decisionCode: 'OVERRIDDEN',
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'overrideReasonCode', code: 'REQUIRED' });
  });

  it('OVERRIDDEN 이 아닌데 사유를 보내면 400 INVALID', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
      overrideReasonCode: 'OTHER',
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'overrideReasonCode', code: 'INVALID' });
  });

  it('basisInspectionId 가 없는 점검이면 400 INVALID', async () => {
    // 존재하지 않는 id — FK 존재만 본다(유형·주기·판정은 화면 몫 · §7-1 3).
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
      basisInspectionId: 999999999,
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'basisInspectionId', code: 'INVALID' });
  });

  it('X-Worker-No 가 worker_no 로 저장된다', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
    }).expect(201);
    expect(response.body.workerNo).toBe(workerNo);
  });

  it('⛔ 응답에 ETag 가 없다', async () => {
    const response = await postDecision({
      workOrderId: workOrderAId,
      equipmentId: equipmentAId,
      decidedAt: T2,
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
    }).expect(201);
    expect(parseIfMatch(String(response.headers.etag ?? ''))).toBeNull();
  });

  it('기록 — 권한 없으면 403 이다', async () => {
    await postDecision(
      {
        workOrderId: workOrderAId,
        equipmentId: equipmentAId,
        decidedAt: T2,
        controlLevelCode: 'WARN',
        decisionCode: 'PASSED',
      },
      { cookie: noPermCookie },
    ).expect(403);
  });

  function postDecision(body: Record<string, unknown>, options: { cookie?: string[] } = {}) {
    return request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', options.cookie ?? cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', workerNo)
      .send(body);
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '통제판정검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '통제판정검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '통제판정검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '통제판정검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const bom = await prisma.bom.create({
      data: { parent_item_id: item.item_id, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'ACTIVE', effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: uom.uom_id },
    });
    const equipmentA = await prisma.equipment.create({
      data: { plant_id: plant.plant_id, equipment_code: `${PREFIX}-EA`, equipment_name: '통제판정검사설비A', equipment_type_code: 'PRESS', status_code: 'IN_SERVICE' },
    });
    equipmentAId = Number(equipmentA.equipment_id);
    const equipmentB = await prisma.equipment.create({
      data: { plant_id: plant.plant_id, equipment_code: `${PREFIX}-EB`, equipment_name: '통제판정검사설비B', equipment_type_code: 'PRESS', status_code: 'IN_SERVICE' },
    });
    equipmentBId = Number(equipmentB.equipment_id);

    const order = await prisma.production_order.create({
      data: { production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, item_id: item.item_id, order_qty: 100, uom_id: uom.uom_id, status_code: 'CONFIRMED' },
    });
    const plan = await prisma.production_plan.create({
      data: { production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date('2026-09-07T00:00:00.000Z'), planned_qty: 100, uom_id: uom.uom_id, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED' },
    });
    const workOrder = async (suffix: string) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'IN_PROGRESS',
        },
      });
    const woA = await workOrder('WOA');
    workOrderAId = Number(woA.work_order_id);
    const woB = await workOrder('WOB');
    // 우회(`OVERRIDDEN`) 판정 e2e 전용 — 서버가 `work_order_type_code` 로 긴급을 판정한다.
    const woEmergency = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOE`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
        work_order_type_code: 'EMERGENCY',
      },
    });
    workOrderEmergencyId = Number(woEmergency.work_order_id);

    await prisma.worker.create({
      data: {
        worker_no: workerNo,
        worker_name: '통제판정검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });

    const decision = (data: {
      workOrderId: bigint;
      equipmentId: bigint;
      decidedAt: string;
      decisionCode: string;
    }) =>
      prisma.precheck_decision.create({
        data: {
          work_order_id: data.workOrderId,
          equipment_id: data.equipmentId,
          decided_at: new Date(data.decidedAt),
          control_level_code: 'WARN',
          decision_code: data.decisionCode,
        },
      });
    const d1 = await decision({ workOrderId: woA.work_order_id, equipmentId: equipmentA.equipment_id, decidedAt: T0, decisionCode: 'PASSED' });
    d1Id = Number(d1.precheck_decision_id);
    const d2 = await decision({ workOrderId: woA.work_order_id, equipmentId: equipmentA.equipment_id, decidedAt: T1, decisionCode: 'BLOCKED' });
    d2Id = Number(d2.precheck_decision_id);
    // d2 와 decided_at 이 같다 — 동률 PK 내림차순 단언에 쓴다.
    const d3 = await decision({ workOrderId: woA.work_order_id, equipmentId: equipmentA.equipment_id, decidedAt: T1, decisionCode: 'WARNED' });
    d3Id = Number(d3.precheck_decision_id);
    const dOther = await decision({ workOrderId: woB.work_order_id, equipmentId: equipmentB.equipment_id, decidedAt: T0, decisionCode: 'PASSED' });
    dOtherId = Number(dOther.precheck_decision_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '통제판정검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '통제판정기록검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    // 권한 0건 계정 — 기록만 403 을 선언하므로 이 계정으로 그 갈래를 본다(역할을 안 붙인다).
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '통제판정권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
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

  /** 만든 행을 FK 역순으로 지운다(§10-1 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    await prisma.precheck_decision.deleteMany({ where: { work_order: { production_plan: { plan_no: { startsWith: PREFIX } } } } });
    await prisma.work_order.deleteMany({ where: { production_plan: { plan_no: { startsWith: PREFIX } } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.user_role.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
