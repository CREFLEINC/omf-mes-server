/**
 * 생산 계획 조회 2건(I-24 PR ①). `POST`·`PUT`·`DELETE`·`:confirm` 은 PR ②③ 몫이다.
 *
 * ⚠ 이 PR 에는 `POST /planning/production-plans` 가 없다 — 계획 행도 **prisma 로 직접
 * INSERT** 한다(`plan_no` 는 픽스처 접두어로 직접 짓는다). PR ② 가 그 자리를 실제
 * POST 호출로 바꾼다(I-24.md §8-1).
 *
 * Routing 3공정(seq 10·20·30) + 의존 2행 · `production_line` 1건은 이 PR 의 테스트가
 * 쓰지 않지만 PR ③(`:confirm`)이 같은 픽스처에 이어 쌓는다 — 미리 세워 둔다.
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

const LOGIN_ID = 'e2e-pp24-probe';
const PASSWORD = 'PP24-검사-비밀번호';
const PREFIX = 'PP24';
const ROLE = 'E2E_PP24';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('생산 계획 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let orderAId = 0;
  let planAId = 0; // productionOrderA · DRAFT · plan_date 2026-09-01
  let planBId = 0; // productionOrderA · CONFIRMED · plan_date 2026-09-10
  let planCId = 0; // productionOrderB · DRAFT · plan_date 2026-09-05

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('목록', () => {
    it('1. productionOrderId 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-plans')
        .query({ productionOrderId: orderAId })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { productionPlanId: number }) => item.productionPlanId)).toEqual([
        planAId,
        planBId,
      ]);
      expect(validator('GET /planning/production-plans')(response.body)).toBe(true);
    });

    it('2. statusCode 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-plans')
        .query({ productionOrderId: orderAId, statusCode: 'CONFIRMED' })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { productionPlanId: number }) => item.productionPlanId)).toEqual([planBId]);
    });

    it('3. planDateFrom·planDateTo 구간으로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-plans')
        .query({ planDateFrom: '2026-09-03', planDateTo: '2026-09-08' })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { productionPlanId: number }) => item.productionPlanId)).toEqual([planCId]);
    });

    it('4. statusCode × planDate 모순은 빈 목록이고 400 이 아니다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-plans')
        .query({ statusCode: 'CONFIRMED', planDateFrom: '2026-09-01', planDateTo: '2026-09-02' })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items).toEqual([]);
    });
  });

  describe('상세', () => {
    it('5. ETag 로 version_no 를 내린다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-plans/${planAId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.headers.etag).toBe('1');
      expect(response.body.splitOfPlanId).toBeUndefined();
      expect(validator('GET /planning/production-plans/{productionPlanId}')(response.body)).toBe(true);
    });

    it('6. 없는 계획은 404', async () => {
      await request(app.getHttpServer())
        .get('/api/planning/production-plans/999999999')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '계획조회검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '계획조회검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '계획조회검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '계획조회검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operations = await Promise.all(
      [10, 20, 30].map((seq) =>
        prisma.routing_operation.create({
          data: { routing_id: routing.routing_id, operation_seq: seq, process_id: process.process_id, operation_name: `공정${seq}` },
        }),
      ),
    );
    // PR ③(:confirm)이 옮길 의존 2행 — 이 PR 의 테스트는 쓰지 않는다(§3-4).
    await prisma.routing_operation_dependency.createMany({
      data: [
        { predecessor_operation_id: operations[0].routing_operation_id, successor_operation_id: operations[1].routing_operation_id },
        { predecessor_operation_id: operations[1].routing_operation_id, successor_operation_id: operations[2].routing_operation_id },
      ],
    });
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
    // PR ③이 `plannedLineId` 로 쓸 라인 — 이 PR 의 테스트는 쓰지 않는다.
    await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '계획조회검사라인' },
    });

    const orderA = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-A`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 500,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
      },
    });
    orderAId = Number(orderA.production_order_id);
    const orderB = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-B`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 300,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
      },
    });

    const planA = await prisma.production_plan.create({
      data: {
        production_order_id: orderA.production_order_id,
        plan_no: `${PREFIX}-PP-A`,
        plan_date: new Date('2026-09-01T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'DRAFT',
      },
    });
    planAId = Number(planA.production_plan_id);
    const planB = await prisma.production_plan.create({
      data: {
        production_order_id: orderA.production_order_id,
        plan_no: `${PREFIX}-PP-B`,
        plan_date: new Date('2026-09-10T00:00:00.000Z'),
        planned_qty: 200,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    planBId = Number(planB.production_plan_id);
    const planC = await prisma.production_plan.create({
      data: {
        production_order_id: orderB.production_order_id,
        plan_no: `${PREFIX}-PP-C`,
        plan_date: new Date('2026-09-05T00:00:00.000Z'),
        planned_qty: 150,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'DRAFT',
      },
    });
    planCId = Number(planC.production_plan_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '계획조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '계획조회검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-01' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** §8-2 — 자가 치유 `deleteMany`(역순). `beforeAll`·`afterAll` 둘 다 부른다. */
  async function cleanup(): Promise<void> {
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    const operations = await prisma.routing_operation.findMany({
      where: { routing: { routing_code: { startsWith: PREFIX } } },
      select: { routing_operation_id: true },
    });
    const operationIds = operations.map((row) => row.routing_operation_id);
    await prisma.routing_operation_dependency.deleteMany({
      where: { OR: [{ predecessor_operation_id: { in: operationIds } }, { successor_operation_id: { in: operationIds } }] },
    });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
