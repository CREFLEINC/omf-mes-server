/**
 * W/O 조회 — 상세 `GET /production/work-orders/{workOrderId}`(ETag) + 4M 계획 배정 목록
 * `GET …/{workOrderId}/resource-plans`(I-6 PR ①).
 *
 * ⛔ 계약이 두 GET 에 403 을 선언하지 않아 권한 가드가 보지 않는다 — 로그인 세션만 심는다.
 * ⭐ 픽스처는 전부 **직접 INSERT** 한다 — 발행(`POST`)·배포(`:release`)가 아직 없다(PR ④·⑤).
 *   시드 마스터가 얇아(품목·공정·라우팅·BOM·작업자·근무조 0행) 이 스위트가 다 심는다.
 */
import { INestApplication } from '@nestjs/common';
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

const LOGIN_ID = 'e2e-wo-probe';
const PASSWORD = 'WO-작업지시-비밀번호';
const PREFIX = 'WOE2E';
/** 선발행 슬롯의 원천 유형 — `lot-rules.ts workOrderWhere()` 와 같은 문자열. */
const LOT_SOURCE = 'WORK_ORDER';

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

describe('W/O 상세·4M 계획 배정 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let workOrderId: number;
  const ids = {
    plant: 0n,
    businessUnit: 0n,
    item: 0n,
    uom: 0n,
    process: 0n,
    routing: 0n,
    routingOperation: 0n,
    bom: 0n,
    worker: 0n,
    shift: 0n,
    productionOrder: 0n,
    productionPlan: 0n,
    workOrder: 0n,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('상세 — 200 에 ETag 가 실린다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/production/work-orders/${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 토큰은 그 행의 version_no 다 — 본문에도 versionNo 가 실린다(재시도 동선 · R-21).
    expect(response.headers.etag).toBe('1');
    expect(response.body).toMatchObject({
      workOrderId,
      versionNo: 1,
      statusCode: 'PLANNED',
      itemCode: `${PREFIX}-IT`,
      routingOperationName: '사출',
      productionOrderNo: `${PREFIX}-PO`,
    });
    // 마감 전이라 `erpMessageQueued` 는 «키가 없다» · 상세에는 `validation` 스위치가 없다.
    expect(Object.keys(response.body as object)).not.toContain('erpMessageQueued');
    expect(Object.keys(response.body as object)).not.toContain('validation');
    // withProgress 기본 true — 다섯 수량이 0 이라도 값으로 실린다.
    expect(response.body.progress).toMatchObject({
      goodQty: 30,
      defectQty: 0,
      achievementRate: 0.3,
      varianceQty: 70,
      completionJudgmentCode: 'UNDER',
      delayStatusCode: 'UNDETERMINABLE',
    });

    const validate = validator('GET /production/work-orders/{workOrderId}');
    expect(validate(response.body)).toBe(true);
  });

  it('상세 — 없는 id 는 404', async () => {
    await request(app.getHttpServer())
      .get('/api/production/work-orders/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('상세 — withPreIssuedLots=true 면 슬롯 집계 세 칸이 온다(2·1·1)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/production/work-orders/${workOrderId}?withPreIssuedLots=true`)
      .set('Cookie', cookie)
      .expect(200);

    // 슬롯 2 · 그중 실적(production_result_lot_allocation)이 붙은 것 1.
    expect(response.body.preIssuedLots).toEqual({ slotCount: 2, withResultCount: 1, withoutResultCount: 1 });
  });

  it('자원계획 목록 — 배정 없으면 빈 배열이다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/production/work-orders/${workOrderId}/resource-plans`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toEqual({ items: [] });

    const validate = validator('GET /production/work-orders/{workOrderId}/resource-plans');
    expect(validate(response.body)).toBe(true);
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '작업지시검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '작업지시검사사업부',
      },
    });
    ids.businessUnit = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '작업지시검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '작업지시검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    ids.process = process.process_id;
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    ids.routing = routing.routing_id;
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: '사출',
      },
    });
    ids.routingOperation = operation.routing_operation_id;
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });
    ids.bom = bom.bom_id;
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '작업지시검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    ids.worker = worker.worker_id;
    const shift = await prisma.shift.create({
      data: {
        plant_id: plant.plant_id,
        shift_code: `${PREFIX}-SH`,
        shift_name: '주간',
        start_time: new Date('1970-01-01T08:00:00.000Z'),
        end_time: new Date('1970-01-01T17:00:00.000Z'),
      },
    });
    ids.shift = shift.shift_id;

    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    ids.productionOrder = order.production_order_id;
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP`,
        plan_date: new Date('2026-09-06T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    ids.productionPlan = plan.production_plan_id;

    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'PLANNED',
      },
    });
    ids.workOrder = workOrder.work_order_id;
    workOrderId = Number(workOrder.work_order_id);

    // 선발행 슬롯 2건 — 첫째만 실적이 붙는다.
    const slots = [];
    for (const seq of [1, 2]) {
      slots.push(
        await prisma.lot.create({
          data: {
            lot_no: `${PREFIX}-LOT-${seq}`,
            item_id: item.item_id,
            lot_type_code: 'PRODUCT',
            plant_id: plant.plant_id,
            initial_qty: 50,
            uom_id: uom.uom_id,
            source_type_code: LOT_SOURCE,
            source_id: workOrder.work_order_id,
            status_code: 'NORMAL',
            work_order_lot_seq: seq,
          },
        }),
      );
    }
    const result = await prisma.production_result.create({
      data: {
        production_result_no: `${PREFIX}-PRD`,
        work_order_id: workOrder.work_order_id,
        result_sequence: 1,
        good_qty: 30,
        uom_id: uom.uom_id,
        result_source_code: 'MANUAL',
        occurred_at: new Date('2026-09-06T01:00:00.000Z'),
        worker_id: worker.worker_id,
        shift_id: shift.shift_id,
        status_code: 'CONFIRMED',
        idempotency_key: `${PREFIX}-${randomUUID()}`,
      },
    });
    await prisma.production_result_lot_allocation.create({
      data: {
        production_result_id: result.production_result_id,
        lot_id: slots[0].lot_id,
        allocated_qty: 30,
        uom_id: uom.uom_id,
      },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '작업지시검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 역순으로 지운다 — FK 방향 그대로. */
  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    await prisma.production_result_lot_allocation.deleteMany({
      where: { production_result: { work_order: { work_order_no: { startsWith: PREFIX } } } },
    });
    await prisma.production_result.deleteMany({ where: { work_order: { work_order_no: { startsWith: PREFIX } } } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order_resource_assignment.deleteMany({
      where: { work_order: { work_order_no: { startsWith: PREFIX } } },
    });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
