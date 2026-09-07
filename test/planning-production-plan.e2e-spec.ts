/**
 * 생산 계획 조회 2 + CRUD 3(I-24 PR ①a·②). `:confirm` 은 PR ③ 몫이다.
 *
 * ⚠ 계획 행은 **실제 `POST /planning/production-plans` 호출**로 만든다(§8-1 관행) —
 * `planB` 만 확정이 필요해 POST 뒤 `prisma.production_plan.update({status_code:'CONFIRMED'})`
 * 로 직접 옮긴다(`:confirm` 이 아직 없다 · PR ③ 이 그 자리를 실제 오퍼레이션으로 바꾼다).
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

function validator(operation: string, status = '200'): ValidateFunction {
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

describe('생산 계획 조회 · CRUD (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let orderAId = 0;
  let orderBId = 0;
  let orderWId = 0; // POST·PUT·DELETE 전용 P/O — 목록 테스트와 겹치지 않는다.
  let uomId = 0;
  let bomId = 0;
  let routingId = 0;
  let lineId = 0;

  let planAId = 0; // productionOrderA · DRAFT · plan_date 2026-09-01
  let planBId = 0; // productionOrderA · CONFIRMED · plan_date 2026-09-10
  let planCId = 0; // productionOrderB · DRAFT · plan_date 2026-09-05
  let planDId = 0; // productionOrderA · DRAFT · plan_date 2026-08-20 — 가장 늦게 만들지만 가장 이른 날짜(정렬이 id 순이 아니라 plan_date 순임을 못 박는다)

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeCatalog();
    await makeUser();
    cookie = await login();
    await makePlanFixtures();
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

      // plan_date asc 다 — id 순(A→B→D)이 아니라 날짜 순(D:08-20→A:09-01→B:09-10)이어야 한다.
      expect(response.body.items.map((item: { productionPlanId: number }) => item.productionPlanId)).toEqual([
        planDId,
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
        .query({ productionOrderId: orderBId, planDateFrom: '2026-09-03', planDateTo: '2026-09-08' })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { productionPlanId: number }) => item.productionPlanId)).toEqual([planCId]);
    });

    it('4. statusCode × planDate 모순은 빈 목록이고 400 이 아니다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-plans')
        .query({ productionOrderId: orderAId, statusCode: 'CONFIRMED', planDateFrom: '2026-09-01', planDateTo: '2026-09-02' })
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

  describe('POST', () => {
    it('7. required 6 으로 만들면 201 이고 statusCode 가 DRAFT 다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderId: orderWId, planDate: '2026-09-21', plannedQty: 40, uomId, bomId, routingId })
        .expect(201);

      expect(response.body.statusCode).toBe('DRAFT');
      expect(validator('POST /planning/production-plans', '201')(response.body)).toBe(true);
    });

    it('8. planNo 가 PP-{YYYYMMDD}-{SEQ4} 형식이고 planDate 를 기간 키로 쓴다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderId: orderWId, planDate: '2026-09-22', plannedQty: 40, uomId, bomId, routingId })
        .expect(201);

      expect(response.body.planNo).toMatch(/^PP-\d{8}-\d{4}$/);
      expect(response.body.planNo.startsWith('PP-20260922-')).toBe(true);
    });

    it('9. 없는 productionOrderId 는 400 INVALID(404 가 아니다)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderId: 999999999, planDate: '2026-09-23', plannedQty: 40, uomId, bomId, routingId })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'productionOrderId', code: 'INVALID' });
    });

    it('10. plannedQty <= 0 은 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderId: orderWId, planDate: '2026-09-23', plannedQty: 0, uomId, bomId, routingId })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'plannedQty', code: 'INVALID' });
    });

    it('11. splitOfPlanId 가 저장되고 응답엔 없다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionOrderId: orderWId,
          planDate: '2026-09-24',
          plannedQty: 10,
          uomId,
          bomId,
          routingId,
          splitOfPlanId: { sourcePlanId: planAId, reasonCode: 'ENGINEERING_CHANGE' },
        })
        .expect(201);

      expect(response.body.splitOfPlanId).toBeUndefined();
      const saved = await prisma.production_plan.findUniqueOrThrow({
        where: { production_plan_id: BigInt(response.body.productionPlanId) },
      });
      expect(saved.split_of_plan_id).toBe(BigInt(planAId));
      expect(saved.split_reason_code).toBe('ENGINEERING_CHANGE');
    });

    it('12. splitOfPlanId.reasonCode 가 그룹 밖이면 400 INVALID', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionOrderId: orderWId,
          planDate: '2026-09-25',
          plannedQty: 10,
          uomId,
          bomId,
          routingId,
          splitOfPlanId: { sourcePlanId: planAId, reasonCode: 'NOT_A_REAL_CODE' },
        })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'splitOfPlanId.reasonCode', code: 'INVALID' });
    });
  });

  describe('PUT', () => {
    let planPutId = 0;

    it('13. DRAFT 계획의 여섯 칸이 고쳐지고 version_no 가 오른다', async () => {
      planPutId = await createPlan('2026-09-26', 15);
      const version = await etagOf(planPutId);

      const response = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${planPutId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .send({
          planDate: '2026-09-27',
          plannedQty: 22,
          bomId,
          routingId,
          plannedLineId: lineId,
          remarks: '수정 메모',
        })
        .expect(200);

      expect(response.body).toMatchObject({ planDate: '2026-09-27', plannedQty: 22, plannedLineId: lineId, remarks: '수정 메모', versionNo: 2 });
    });

    it('14. plannedLineId:null·remarks:null 은 해제, 생략은 유지다', async () => {
      const version = await etagOf(planPutId);

      const response = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${planPutId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .send({ plannedLineId: null, remarks: null })
        .expect(200);

      expect(response.body.plannedLineId).toBeUndefined();
      expect(response.body.remarks).toBeUndefined();
      // planDate·plannedQty 는 생략했으니 test13 값을 유지한다.
      expect(response.body).toMatchObject({ planDate: '2026-09-27', plannedQty: 22, versionNo: 3 });
    });

    it('14-1. plannedQty 가 0 이면 400 INVALID — DB CHECK 를 앞지른다', async () => {
      const version = await etagOf(planPutId);

      const response = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${planPutId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .send({ plannedQty: 0 })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'plannedQty', code: 'INVALID' });
    });

    it('15. If-Match 어긋남은 409 VERSION_CONFLICT', async () => {
      const response = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${planPutId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ remarks: '충돌' })
        .expect(409);

      expect(response.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
    });

    it('16. 확정된 계획은 400 STATE_LOCKED — If-Match 를 맞게 보내도 그렇다', async () => {
      const confirmedId = await createPlan('2026-09-28', 5);
      // ⚠ `:confirm` 이 아직 없다(PR ③ 몫) — 상태만 직접 옮겨 잠금을 검사한다.
      await prisma.production_plan.update({
        where: { production_plan_id: BigInt(confirmedId) },
        data: { status_code: 'CONFIRMED' },
      });
      const version = await etagOf(confirmedId);

      const response = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${confirmedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .send({ remarks: '확정 뒤 수정 시도' })
        .expect(400);

      expect(response.body.errors[0]).toMatchObject({ field: 'statusCode', code: 'STATE_LOCKED' });

      // ⭐ 순서(잠금 → If-Match → 상태)를 가르는 유일한 조합 — 확정된 계획에 «어긋난» 토큰을
      // 주면 상태 검사(400)가 아니라 토큰 검사(409)가 먼저 걸린다(§4-2 · 리뷰 #276 Minor).
      const conflict = await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${confirmedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '99')
        .send({ remarks: '토큰이 먼저다' })
        .expect(409);

      expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    });
  });

  describe('DELETE', () => {
    it('17. DRAFT 계획을 지우면 204 이고 행이 사라진다', async () => {
      const deletableId = await createPlan('2026-09-29', 8);
      const version = await etagOf(deletableId);

      await request(app.getHttpServer())
        .delete(`/api/planning/production-plans/${deletableId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/planning/production-plans/${deletableId}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it('18. 확정된 계획은 409 INVALID_STATE(400 도 404 도 아니다)', async () => {
      const confirmedId = await createPlan('2026-09-30', 8);
      // ⚠ `:confirm` 이 아직 없다(PR ③ 몫) — 상태만 직접 옮겨 잠금을 검사한다.
      await prisma.production_plan.update({
        where: { production_plan_id: BigInt(confirmedId) },
        data: { status_code: 'CONFIRMED' },
      });
      const version = await etagOf(confirmedId);

      const response = await request(app.getHttpServer())
        .delete(`/api/planning/production-plans/${confirmedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .expect(409);

      expect(response.body).toMatchObject({ conflictCause: 'user', code: 'INVALID_STATE' });

      // ⭐ 같은 순서 그물 — 확정된 계획 + 어긋난 토큰이면 409 VERSION_CONFLICT 가 먼저다.
      const conflict = await request(app.getHttpServer())
        .delete(`/api/planning/production-plans/${confirmedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '99')
        .expect(409);

      expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('19. If-Match 어긋남은 409 VERSION_CONFLICT', async () => {
      const targetId = await createPlan('2026-10-01', 8);

      const response = await request(app.getHttpServer())
        .delete(`/api/planning/production-plans/${targetId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '99')
        .expect(409);

      expect(response.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
    });

    it('20. 분할 자식이 있는 원본 계획은 409 INVALID_STATE(§0 R-8 — SUCCESSOR_EXISTS 가 아니다)', async () => {
      const originId = await createPlan('2026-10-02', 30);
      await request(app.getHttpServer())
        .post('/api/planning/production-plans')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionOrderId: orderWId,
          planDate: '2026-10-03',
          plannedQty: 10,
          uomId,
          bomId,
          routingId,
          splitOfPlanId: { sourcePlanId: originId, reasonCode: 'PART_SHORTAGE' },
        })
        .expect(201);
      const version = await etagOf(originId);

      const response = await request(app.getHttpServer())
        .delete(`/api/planning/production-plans/${originId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', version)
        .expect(409);

      expect(response.body).toMatchObject({ conflictCause: 'user', code: 'INVALID_STATE' });
      expect(response.body.message).toContain('분할');
    });
  });

  /** POST 로 DRAFT 계획 하나를 만들고 id 를 돌려준다(§8-1 관행 — 픽스처를 오퍼레이션으로 세운다). */
  async function createPlan(planDate: string, plannedQty: number): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/planning/production-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderId: orderWId, planDate, plannedQty, uomId, bomId, routingId })
      .expect(201);
    return response.body.productionPlanId as number;
  }

  /** 상세 GET 의 ETag(`version_no`)를 문자열로 돌려준다. */
  async function etagOf(productionPlanId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/planning/production-plans/${productionPlanId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag as string;
  }

  async function makeCatalog(): Promise<void> {
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
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '계획조회검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    routingId = Number(routing.routing_id);
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
    bomId = Number(bom.bom_id);
    const line = await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '계획조회검사라인' },
    });
    lineId = Number(line.production_line_id);

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
    orderBId = Number(orderB.production_order_id);
    // POST·PUT·DELETE 전용 — 목록·정렬 단언(orderA·orderB)과 계획 수가 섞이지 않는다.
    const orderW = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-W`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 1000,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
      },
    });
    orderWId = Number(orderW.production_order_id);
  }

  /** 목록·상세 테스트가 쓰는 계획 넷 — 전부 실제 `POST` 로 만든다(§8-1 관행). */
  async function makePlanFixtures(): Promise<void> {
    const planA = await request(app.getHttpServer())
      .post('/api/planning/production-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderId: orderAId, planDate: '2026-09-01', plannedQty: 100, uomId, bomId, routingId })
      .expect(201);
    planAId = planA.body.productionPlanId as number;
    // ⚠ `:confirm` 이 아직 없다(PR ③ 몫) — POST(DRAFT) 뒤 상태만 직접 옮긴다.
    const planB = await request(app.getHttpServer())
      .post('/api/planning/production-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderId: orderAId, planDate: '2026-09-10', plannedQty: 200, uomId, bomId, routingId })
      .expect(201);
    planBId = planB.body.productionPlanId as number;
    await prisma.production_plan.update({
      where: { production_plan_id: BigInt(planBId) },
      data: { status_code: 'CONFIRMED' },
    });

    const planC = await request(app.getHttpServer())
      .post('/api/planning/production-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderId: orderBId, planDate: '2026-09-05', plannedQty: 150, uomId, bomId, routingId })
      .expect(201);
    planCId = planC.body.productionPlanId as number;

    // 가장 늦게 만들지만(id 최대) 날짜는 가장 이르다 — `plan_date asc` 가 1순위임을 못 박는다.
    const planD = await request(app.getHttpServer())
      .post('/api/planning/production-plans')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderId: orderAId, planDate: '2026-08-20', plannedQty: 50, uomId, bomId, routingId })
      .expect(201);
    planDId = planD.body.productionPlanId as number;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '계획조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '계획조회검사용' } });
    await prisma.role_permission.createMany({
      data: [
        { role_id: role.role_id, permission_code: 'W-02-01' },
        { role_id: role.role_id, permission_code: 'W-02-02' },
      ],
    });
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

  /** §8-2 — 자가 치유 `deleteMany`(역순 · 분할 자식 먼저). `beforeAll`·`afterAll` 둘 다 부른다.
   *  ⚠ `plan_no` 는 이제 채번(`PP-{YYYYMMDD}-{SEQ4}`)이 지어 `PREFIX` 로 시작하지 않는다 —
   *  `production_order` 관계로 좁힌다. */
  async function cleanup(): Promise<void> {
    const scope = { production_order: { production_order_no: { startsWith: PREFIX } } };
    await prisma.production_plan.deleteMany({ where: { ...scope, split_of_plan_id: { not: null } } });
    await prisma.production_plan.deleteMany({ where: scope });
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
