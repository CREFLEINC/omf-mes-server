/**
 * W/O 조회 — 상세 `GET /production/work-orders/{workOrderId}`(ETag) + 4M 계획 배정 목록
 * `GET …/{workOrderId}/resource-plans`(I-6 PR ①).
 *
 * 4M 계획 배정 추가·해제(`POST`/`DELETE`)와 유효성 점검 `GET …/validation`(I-6 PR ③),
 * 발행 `POST`·수정 `PUT`·중단 `:hold`·재개 `:resume`(I-6 PR ④)을 잇는다.
 *
 * ⛔ 계약이 403 을 선언한 것은 `validation` 하나뿐이라 그 자리만 권한 가드가 본다 — 나머지
 *   넷은 로그인 세션만으로 통과한다. 그래서 사용자가 둘이다(권한 있음·없음).
 * 확정·배포 `:release` + 생산LOT 선발행 + 자재 출고요청 자동 발행(I-6 PR ⑤b)을 잇는다.
 *
 * ⭐ 마스터 픽스처는 **직접 INSERT** 한다 — 시드가 얇아(품목·공정·라우팅·BOM·작업자·근무조
 *   0행) 이 스위트가 다 심는다.
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
const NOPERM_ID = 'e2e-wo-noperm';
const PASSWORD = 'WO-작업지시-비밀번호';
const PREFIX = 'WOE2E';
const ROLE = 'E2E_WORK_ORDER';
/**
 * 계약이 403 을 선언한 여덟 자리의 화면 권한 — `derived-permissions.ts` 가 계약에서 도출한
 * 값이다(`validation`·`PUT` = `W-02-03` · `POST` = `W-02-02` · `:hold`/`:resume` = `P-02-10` ·
 * `:release` = `W-02-04` · `:close` = `W-02-05` · `:cancel` = `W-02-06`).
 * ⭐ `W-02-06` 은 `GET /integration/messages`(403 선언)도 연다 — 마감이 적재한 행을 그 경로로 본다.
 */
const PERMISSIONS = ['W-02-03', 'W-02-02', 'P-02-10', 'W-02-04', 'W-02-05', 'W-02-06'];
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
  let noPermCookie: string[];

  let workOrderId: number;
  /** 설비·작업자가 «같은 숫자 id» 를 갖도록 못박은 값 — 유형이 유일키를 가르는지 보려면 필요하다. */
  let twinId: bigint;
  let equipmentPlanId: number;
  /** 목록 GET(PR ②) 전용 — `workOrder` 의 후속(의존 표 1행) · priority_no 가 더 낮다. */
  let secondWorkOrderId: number;
  /** `releasable`·`withValidation` e2e 전용 — EMERGENCY 유형(계획 없음), 후보 집합에서부터 빠진다. */
  let emergencyWorkOrderId: number;
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
    equipment: 0n,
    shift: 0n,
    productionOrder: 0n,
    productionPlan: 0n,
    workOrder: 0n,
    terminal: 0n,
    location: 0n,
    fgLocation: 0n,
    scrapLocation: 0n,
    componentItemA: 0n,
    componentItemB: 0n,
    overflowPlan: 0n,
    /** 배포 전 필수 — W/O 공장과 같은 공장의 라인(omf-all-around#36). */
    productionLine: 0n,
    /** 배포가 막아야 할 어긋난 라인 — 다른 공장 소속이다. */
    otherPlantLine: 0n,
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

  describe('4M 계획 배정 쓰기 · 유효성 점검 (PR ③)', () => {
    const plans = (): string => `/api/production/work-orders/${workOrderId}/resource-plans`;

    it('자원계획 — 같은 자원 재배정은 409 다', async () => {
      const created = await request(app.getHttpServer())
        .post(plans())
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ resourceTypeCode: 'EQUIPMENT', resourceId: Number(twinId) })
        .expect(201);

      expect(created.body).toMatchObject({ workOrderId, resourceTypeCode: 'EQUIPMENT', resourceId: Number(twinId) });
      expect(validator('POST /production/work-orders/{workOrderId}/resource-plans', 201)(created.body)).toBe(true);
      equipmentPlanId = created.body.workOrderResourcePlanId;

      const rejected = await request(app.getHttpServer())
        .post(plans())
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ resourceTypeCode: 'EQUIPMENT', resourceId: Number(twinId) })
        .expect(409);

      // ⚠ 이 자리의 409 봉투만 `ErrorResponse` 다 — 다른 409 는 `ProductionConflictResponse` 다.
      expect(rejected.body.errors[0]).toMatchObject({ field: 'resourceId', code: 'UNIQUE_VIOLATION' });
      expect(validator('POST /production/work-orders/{workOrderId}/resource-plans', 409)(rejected.body)).toBe(true);
    });

    it('자원계획 — 유형이 다르면 같은 id 라도 배정된다', async () => {
      // 유일 인덱스 식은 `(work_order_id, resource_type_code, COALESCE(...))` 라 유형이 가른다.
      const created = await request(app.getHttpServer())
        .post(plans())
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ resourceTypeCode: 'WORKER', resourceId: Number(twinId) })
        .expect(201);

      expect(created.body).toMatchObject({ resourceTypeCode: 'WORKER', resourceId: Number(twinId) });

      const listed = await request(app.getHttpServer()).get(plans()).set('Cookie', cookie).expect(200);
      expect(listed.body.items).toHaveLength(2);
      // 물리는 네 칸으로 갈라 담고 넷 중 하나만 non-null 이다(`ck_work_order_resource_target`).
      const row = await prisma.work_order_resource_assignment.findUniqueOrThrow({
        where: { work_order_resource_assignment_id: BigInt(created.body.workOrderResourcePlanId) },
      });
      expect([row.equipment_id, row.mold_id, row.worker_id, row.shift_id]).toEqual([null, null, twinId, null]);
      expect(row.assignment_status_code).toBe('PLANNED');
    });

    it('자원계획 — 해제는 204 이고 두 번째는 404 다', async () => {
      const url = `${plans()}/${equipmentPlanId}`;
      await request(app.getHttpServer())
        .delete(url)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .expect(204);
      await request(app.getHttpServer())
        .delete(url)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .expect(404);
    });

    it('유효성 — 권한 없으면 403 이다', async () => {
      await prisma.work_order.update({
        where: { work_order_id: BigInt(workOrderId) },
        data: { planned_equipment_id: twinId },
      });
      await prisma.equipment.update({ where: { equipment_id: twinId }, data: { status_code: 'DISPOSED' } });

      // 200 갈래를 함께 못박는다 — 권한이 있으면 규칙 여섯의 판정이 계약 스키마대로 온다.
      const report = await request(app.getHttpServer())
        .get(`/api/production/work-orders/${workOrderId}/validation`)
        .set('Cookie', cookie)
        .expect(200);

      expect(report.body.passed).toBe(false);
      expect(report.body.findings).toContainEqual(
        expect.objectContaining({ severity: 'BLOCK', code: 'EQUIPMENT_NOT_IN_SERVICE', field: 'plannedEquipmentId' }),
      );
      expect(validator('GET /production/work-orders/{workOrderId}/validation')(report.body)).toBe(true);

      await request(app.getHttpServer())
        .get(`/api/production/work-orders/${workOrderId}/validation`)
        .set('Cookie', noPermCookie)
        .expect(403);
    });
  });

  describe('목록 GET (PR ②)', () => {
    it('목록 — 기간을 비워도 400 이 아니다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/production/work-orders')
        .set('Cookie', cookie)
        .expect(200);

      const validate = validator('GET /production/work-orders');
      const valid = validate(response.body);
      if (!valid) throw new Error(JSON.stringify(validate.errors));
      expect(valid).toBe(true);
    });

    it('목록 — withSummary=true 면 요약이 필터 전체 기준이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?productionPlanId=${ids.productionPlan}&withSummary=true&size=1`)
        .set('Cookie', cookie)
        .expect(200);

      // 쪽은 size=1 로 잘렸어도 요약의 totalCount 는 필터에 걸린 전체(이 계획 아래 W/O 2건)다.
      expect(response.body.items).toHaveLength(1);
      expect(response.body.page.total).toBe(2);
      expect(response.body.summary.totalCount).toBe(2);
      expect(validator('GET /production/work-orders')(response.body)).toBe(true);
    });

    it('목록 — successorOfWorkOrderId 가 의존 표를 푼다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?successorOfWorkOrderId=${workOrderId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.items.map((item: { workOrderId: number }) => item.workOrderId)).toEqual([secondWorkOrderId]);
    });

    it('목록 — 기본 정렬이 priorityNo,asc 다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?productionPlanId=${ids.productionPlan}`)
        .set('Cookie', cookie)
        .expect(200);

      // secondWorkOrder(priority_no=10)가 workOrder(기본값 100)보다 앞선다.
      expect(response.body.items.map((item: { workOrderId: number }) => item.workOrderId)).toEqual([
        secondWorkOrderId,
        workOrderId,
      ]);
    });

    it('목록 — releasable=true 는 BLOCK 있는 W/O 를 뺀다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?q=${PREFIX}&releasable=true`)
        .set('Cookie', cookie)
        .expect(200);

      const itemIds = response.body.items.map((item: { workOrderId: number }) => item.workOrderId);
      // workOrder 는 설비(twinId)가 DISPOSED 라 BLOCK(EQUIPMENT_NOT_IN_SERVICE) 이다 — 후보였지만 걸러진다.
      expect(itemIds).not.toContain(workOrderId);
      // secondWorkOrder 는 자원 배정이 있고 BLOCK 이 없어 통과한다(대조군).
      expect(itemIds).toContain(secondWorkOrderId);
      expect(response.body.page.total).toBe(itemIds.length);
      expect(validator('GET /production/work-orders')(response.body)).toBe(true);
    });

    it('목록 — releasable=false 는 긴급·미배정도 낸다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?q=${PREFIX}&releasable=false`)
        .set('Cookie', cookie)
        .expect(200);

      const itemIds = response.body.items.map((item: { workOrderId: number }) => item.workOrderId);
      // 후보였으나 BLOCK 인 workOrder · 유형부터 후보 밖인 emergencyWorkOrder 둘 다 여집합에 든다.
      expect(itemIds).toContain(workOrderId);
      expect(itemIds).toContain(emergencyWorkOrderId);
      // secondWorkOrder 는 releasable=true 의 통과자라 false 여집합에는 없다.
      expect(itemIds).not.toContain(secondWorkOrderId);
    });

    it('목록 — withValidation=true 는 항목마다 validation 요약을 싣는다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/production/work-orders?productionPlanId=${ids.productionPlan}&withValidation=true`)
        .set('Cookie', cookie)
        .expect(200);

      const byId = new Map(
        response.body.items.map((item: { workOrderId: number; validation: unknown }) => [item.workOrderId, item.validation]),
      );
      expect(byId.get(workOrderId)).toMatchObject({ passed: false, blockCount: 1 });
      expect(byId.get(secondWorkOrderId)).toMatchObject({ passed: true, blockCount: 0 });
      for (const validation of byId.values()) {
        expect(validation).toEqual(
          expect.objectContaining({ passed: expect.any(Boolean), blockCount: expect.any(Number), warnCount: expect.any(Number) }),
        );
      }
      expect(validator('GET /production/work-orders')(response.body)).toBe(true);
    });
  });

  describe('발행·수정·중단·재개 (PR ④)', () => {
    const base = '/api/production/work-orders';
    let issuedId = 0;
    let issuedEtag = '';

    /** ⑤b 전 — `:release` 가 없어 배포 상태를 직접 심는다. */
    async function released(): Promise<number> {
      const id = await issue();
      await prisma.work_order.update({
        where: { work_order_id: BigInt(id) },
        data: { status_code: 'RELEASED', released_at: new Date() },
      });
      return id;
    }

    async function issue(): Promise<number> {
      const response = await request(app.getHttpServer())
        .post(base)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionPlanId: Number(ids.productionPlan),
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty: 40,
          uomId: Number(ids.uom),
        })
        .expect(201);
      return response.body.workOrderId;
    }

    it('발행 — 201 에 ETag 가 실리고 그 토큰이 PUT 에 그대로 통한다', async () => {
      const created = await request(app.getHttpServer())
        .post(base)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionPlanId: Number(ids.productionPlan),
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty: 40,
          uomId: Number(ids.uom),
          remarks: '발행 검사',
        })
        .expect(201);

      // ⭐ 토큰을 받으려고 상세를 다시 조회하지 않는다(계약 x-internal-note · omf-mes#258).
      expect(created.headers.etag).toBe('1');
      expect(created.body).toMatchObject({
        statusCode: 'PLANNED',
        // 유형을 안 보냈으니 서버가 `NORMAL` 을 «명시»로 넣는다.
        workOrderTypeCode: 'NORMAL',
        priorityNo: 100,
        versionNo: 1,
      });
      expect(created.body.workOrderNo).toMatch(/^WO-\d{8}-\d{4}$/);
      expect(validator('POST /production/work-orders', 201)(created.body)).toBe(true);
      issuedId = created.body.workOrderId;
      issuedEtag = created.headers.etag;

      const updated = await request(app.getHttpServer())
        .put(`${base}/${issuedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', issuedEtag)
        .send({ priorityNo: 5, plannedEquipmentId: Number(ids.equipment) })
        .expect(200);

      // ⛔ 200 에 «잠금 토큰» ETag 가 없다(계약 미선언 — express 의 약한 해시가 남을 뿐이다).
      //    다음 If-Match 는 본문 `versionNo` 가 준다(R-22).
      expect(updated.headers.etag ?? '').not.toMatch(/^\d+$/);
      expect(updated.body).toMatchObject({ priorityNo: 5, plannedEquipmentId: Number(ids.equipment), versionNo: 2 });
      expect(validator('PUT /production/work-orders/{workOrderId}')(updated.body)).toBe(true);
    });

    it('발행 — 계획을 비우면 400 이고 아무것도 생기지 않는다', async () => {
      const before = await counted();

      const rejected = await request(app.getHttpServer())
        .post(base)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionPlanId: null,
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty: 40,
          uomId: Number(ids.uom),
        })
        .expect(400);

      expect(rejected.body.errors[0]).toMatchObject({ field: 'productionPlanId', code: 'REQUIRED' });
      // ⭐ 검사가 채번보다 앞이라 카운터도 안 오른다(결번을 남기지 않는다).
      expect(await counted()).toEqual(before);
    });

    it('중단 — If-Match 가 없어도 200 이다(선택)', async () => {
      const workOrder = await released();

      const held = await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z', note: '설비 정지' })
        .expect(200);

      expect(held.body).toMatchObject({ statusCode: 'SUSPENDED', versionNo: 2 });
      expect(validator('POST /production/work-orders/{workOrderId}:hold')(held.body)).toBe(true);
    });

    it('중단 — 낡은 토큰을 실으면 409 다', async () => {
      const workOrder = await released();
      await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(200);

      // 이제 그 행은 2 다 — 1 을 다시 실으면 저장 충돌이고, 상태 자물쇠보다 «앞»에서 걸린다.
      const stale = await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(409);

      // 봉투가 `ProductionConflictResponse` 다 — `code` 가 required 이고 `conflictCause` 도 함께 온다.
      expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', conflictCause: 'user' });
      expect(stale.body.errors).toBeUndefined();
      expect(validator('POST /production/work-orders/{workOrderId}:hold', 409)(stale.body)).toBe(true);
    });

    it('중단 — `X-Worker-No` 가 없어도 400 이 아니다', async () => {
      const workOrder = await released();

      // 계약이 헤더를 선언했지만 담을 칸이 없어 서버가 읽지 않는다(§6-2 ⓔ · 출고 선례).
      await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(200);
    });

    it('중단 — 세션의 `ended_at`·`status_code` 가 그대로다', async () => {
      const workOrder = await released();
      const session = await prisma.work_session.create({
        data: {
          work_order_id: BigInt(workOrder),
          session_no: 1,
          shift_id: ids.shift,
          terminal_id: ids.terminal,
          started_at: new Date('2026-09-06T01:00:00.000Z'),
          status_code: 'RUNNING',
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });

      await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(200);

      // ⭐ 계약이 두 번 못박았다 — 「세션은 닫지 않는다」. 세션 층은 events 의 STOP 이 옮긴다.
      const after = await prisma.work_session.findUniqueOrThrow({
        where: { work_session_id: session.work_session_id },
      });
      expect(after.ended_at).toBeNull();
      expect(after.status_code).toBe('RUNNING');
    });

    it('재개 — `SUSPENDED` 가 아니면 400 이다', async () => {
      const rejected = await request(app.getHttpServer())
        .post(`${base}/${issuedId}:resume`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(400);

      // ⛔ 409 가 아니다 — 재로드해도 풀리지 않는 잠금이다(G-1 · §1-6).
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('중단·재개 — 권한 없으면 403 이다', async () => {
      const workOrder = await released();

      await request(app.getHttpServer())
        .post(`${base}/${workOrder}:hold`)
        .set('Cookie', noPermCookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'EQUIPMENT_FAULT', occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(403);

      await request(app.getHttpServer())
        .post(`${base}/${workOrder}:resume`)
        .set('Cookie', noPermCookie)
        .set('Idempotency-Key', randomUUID())
        .send({ occurredAt: '2026-09-06T02:00:00.000Z' })
        .expect(403);
    });

    it('수정 — 같은 멱등키 재전송이 버전을 두 번 올리지 않는다', async () => {
      const key = randomUUID();
      const body = { remarks: null, plannedMoldId: null };
      const first = await request(app.getHttpServer())
        .put(`${base}/${issuedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '2')
        .send(body)
        .expect(200);
      // 같은 키·같은 지문이라 두 번째는 앞의 응답을 그대로 돌려받는다 — 버전은 한 번만 오른다.
      const again = await request(app.getHttpServer())
        .put(`${base}/${issuedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '2')
        .send(body)
        .expect(200);

      expect(first.body.versionNo).toBe(3);
      expect(again.body.versionNo).toBe(3);
      const row = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(issuedId) } });
      expect(row.version_no).toBe(3);
      // 명시적 null 은 해제다 — 생략한 `priorityNo` 는 앞 수정의 5 로 남는다.
      expect(row.remarks).toBeNull();
      expect(row.priority_no).toBe(5);
    });

    it('수정 — If-Match 가 없으면 400 이다', async () => {
      const bare = await request(app.getHttpServer())
        .put(`${base}/${issuedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ priorityNo: 7 });

      expect(bare.status).toBe(400);
    });

    it('수정 — 낡은 If-Match 는 409 이고 본문이 {conflictCause:"user", code:"VERSION_CONFLICT"} 다', async () => {
      const stale = await request(app.getHttpServer())
        .put(`${base}/${issuedId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        // 앞선 테스트들로 버전이 이미 3 을 지났다 — '1' 은 확실히 낡았다.
        .set('If-Match', '1')
        .send({ priorityNo: 8 });

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
    });

    /** 이 스위트가 만든 W/O 수 + `WORK_ORDER` 채번 카운터. 둘 다 안 움직여야 「아무것도 안 생겼다」다. */
    async function counted(): Promise<[number, string]> {
      const orders = await prisma.work_order.count({ where: { production_plan_id: ids.productionPlan } });
      const counters = await prisma.numbering_counter.findMany({
        where: { numbering_rule: { document_type_code: 'WORK_ORDER' } },
        select: { last_value: true },
      });
      return [orders, counters.map((row) => String(row.last_value)).join(',')];
    }
  });


  describe('확정·배포 + 자재 출고요청 자동 발행 (PR ⑤b)', () => {
    const base = '/api/production/work-orders';
    let seq = 0;

    /** 배포 대상 W/O — 상태·기본 위치·라인을 픽스처로 못박는다(발행 경로는 ④가 이미 본다). */
    async function planned(data: Record<string, unknown> = {}): Promise<number> {
      const row = await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-WOR${++seq}`,
          production_plan_id: ids.productionPlan,
          routing_operation_id: ids.routingOperation,
          item_id: ids.item,
          order_qty: 100,
          uom_id: ids.uom,
          status_code: 'PLANNED',
          production_line_id: ids.productionLine,
          default_wip_location_id: ids.location,
          default_fg_location_id: ids.fgLocation,
          default_scrap_location_id: ids.scrapLocation,
          ...data,
        },
      });
      return Number(row.work_order_id);
    }

    const call = (workOrderId: number, lotSize: number, etag = '1', key = randomUUID()) =>
      request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', etag)
        .send({ lotSize });

    const slots = (workOrderId: number) =>
      prisma.lot.findMany({
        where: { source_type_code: LOT_SOURCE, source_id: BigInt(workOrderId) },
        orderBy: { work_order_lot_seq: 'asc' },
      });

    const requests = (workOrderId: number) =>
      prisma.material_issue_request.findMany({
        where: { work_order_id: BigInt(workOrderId) },
        include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
      });

    it('배포 — 슬롯 N 개가 `WAITING` 으로 생기고 상태가 `RELEASED` 다', async () => {
      const workOrderId = await planned();

      const response = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ lotSize: 30, handoverNote: '전달사항입니다' })
        .expect(200);

      expect(response.body).toMatchObject({ workOrderId, statusCode: 'RELEASED', versionNo: 2 });
      expect(response.body.releasedAt).toEqual(expect.any(String));
      // ⛔ `handoverNote` 는 저장하지 않는다 — `remarks` 에 덧붙이지도 않는다(§4-5).
      expect(response.body.remarks ?? null).toBeNull();
      // 굳힐 두 칸이 둘 다 NULL 이라 빈 객체다(R-27).
      expect(response.body.operationSettingsSnapshot).toEqual({});
      expect(validator('POST /production/work-orders/{workOrderId}:release')(response.body)).toBe(true);

      const lots = await slots(workOrderId);
      // 100 ÷ 30 → 4슬롯이고 마지막만 나머지다. 합이 지시수량과 정확히 같다.
      expect(lots.map((lot) => lot.initial_qty.toNumber())).toEqual([30, 30, 30, 10]);
      expect(lots.map((lot) => lot.work_order_lot_seq)).toEqual([1, 2, 3, 4]);
      expect(lots.map((lot) => lot.lifecycle_status_code)).toEqual(Array(4).fill('WAITING'));
      expect(lots.map((lot) => lot.lot_type_code)).toEqual(Array(4).fill('PRODUCTION'));
      // BOM 스냅샷은 계획의 것이고 짝을 지킨다.
      expect(lots.map((lot) => lot.bom_version)).toEqual([1, 1, 1, 1]);
      // ⛔ 실물이 없어 수입검사 보류를 걸지 않는다(입하 등록과 다르다).
      const held = await prisma.lot_hold.count({
        where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
      });
      expect(held).toBe(0);
    });

    it('배포 — 라인이 있으면 공장은 여전히 계획 한 축으로 풀린다', async () => {
      const workOrderId = await planned();

      await call(workOrderId, 100).expect(200);

      // R-7 — 공장은 계획의 생산오더 공장으로 푼다(라인은 배포 «전제»일 뿐이다).
      // ⚠ 라인이 배포 전제가 된 뒤로 이 검사는 «두 축이 갈리는» 경우를 못 만든다 — 다른 공장
      //   라인은 400 이라 200 이 안 나온다. 축이 새는 회귀는 단말 권한 검사 쪽 e2e 가 잡는다.
      const lots = await slots(workOrderId);
      expect(lots).toHaveLength(1);
      expect(lots[0].plant_id).toBe(ids.plant);
      expect((await requests(workOrderId))[0].destination_location_id).toBe(ids.location);
    });

    /**
     * omf-all-around#36 — 라인 없는 W/O 는 배포·출고까지 되고 현장 단말에서만 전부 막혔다.
     * 단말 권한 검사가 «라인의 공장»으로 판정하기 때문이다. 배포에서 먼저 막는다.
     */
    it('배포 — 생산라인이 비어 있으면 400 REQUIRED 이며 슬롯·요청을 만들지 않는다', async () => {
      const workOrderId = await planned({ production_line_id: null });

      const response = await call(workOrderId, 100).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'productionLineId', code: 'REQUIRED' }),
      ]);
      expect(await slots(workOrderId)).toEqual([]);
      expect(await requests(workOrderId)).toEqual([]);
      expect((await prisma.work_order.findUniqueOrThrow({
        where: { work_order_id: BigInt(workOrderId) },
      })).status_code).toBe('PLANNED');
    });

    it('배포 — 다른 공장 라인이면 400 INVALID 다(배포돼도 단말이 거부할 짝이다)', async () => {
      const workOrderId = await planned({ production_line_id: ids.otherPlantLine });

      const response = await call(workOrderId, 100).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'productionLineId', code: 'INVALID' }),
      ]);
      expect(await slots(workOrderId)).toEqual([]);
      expect((await prisma.work_order.findUniqueOrThrow({
        where: { work_order_id: BigInt(workOrderId) },
      })).status_code).toBe('PLANNED');
    });

    it('배포 — 기본 위치 세 곳이 빠지면 필드별 400이며 슬롯·요청을 만들지 않는다', async () => {
      const workOrderId = await planned({
        default_wip_location_id: null,
        default_fg_location_id: null,
        default_scrap_location_id: null,
      });

      const response = await call(workOrderId, 100).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'defaultWipLocationId', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'defaultFgLocationId', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'defaultScrapLocationId', code: 'REQUIRED' }),
      ]);
      expect(await slots(workOrderId)).toEqual([]);
      expect(await requests(workOrderId)).toEqual([]);
      expect((await prisma.work_order.findUniqueOrThrow({
        where: { work_order_id: BigInt(workOrderId) },
      })).status_code).toBe('PLANNED');
    });

    it('배포 — 출고요청 1건과 BOM 라인 수만큼의 라인이 생긴다', async () => {
      const workOrderId = await planned();

      await call(workOrderId, 100).expect(200);

      const [issued, ...rest] = await requests(workOrderId);
      expect(rest).toEqual([]);
      expect(issued.issue_request_no).toMatch(/^MIR-\d{8}-\d{4}$/);
      expect(issued).toMatchObject({
        status_code: 'REGISTERED',
        destination_location_id: ids.location,
        required_at: null,
        reason_code: null,
      });
      // BOM 구성 3행 중 «이 공정»의 둘만 담는다 — 공정 미지정 1행은 빠진다.
      const lines = issued.material_issue_request_line;
      expect(lines.map((line) => line.line_no)).toEqual([1, 2]);
      expect(lines.map((line) => line.item_id)).toEqual([ids.componentItemA, ids.componentItemB]);
      // 2×100÷1 = 200 · 0.5×100÷1 = 50. 둘째의 스크랩률 5% 를 곱했다면 52.5 다(문의 037).
      expect(lines.map((line) => line.requested_qty.toNumber())).toEqual([200, 50]);
      expect(lines.map((line) => line.bom_component_id === null)).toEqual([false, false]);
    });

    it('배포 — 긴급 W/O 는 슬롯은 생기고 출고요청은 0건이다', async () => {
      const workOrderId = await planned({ work_order_type_code: 'EMERGENCY' });

      await call(workOrderId, 40).expect(200);

      // 긴급 경로에서도 선발행은 «일어난다» — 현장이 정상 경로 화면을 재사용한다(계약).
      expect((await slots(workOrderId)).map((lot) => lot.initial_qty.toNumber())).toEqual([40, 40, 20]);
      expect(await requests(workOrderId)).toEqual([]);
    });

    it('배포 — If-Match 가 없으면 400, 낡으면 409 다', async () => {
      const workOrderId = await planned();

      const missing = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ lotSize: 100 })
        .expect(400);
      expect(missing.body.errors[0]).toMatchObject({ code: 'REQUIRED' });

      const stale = await call(workOrderId, 100, '99').expect(409);
      expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });
      expect(validator('POST /production/work-orders/{workOrderId}:release', 409)(stale.body)).toBe(true);
      expect(await slots(workOrderId)).toEqual([]);
    });

    it('배포 — 같은 멱등키 재전송이 슬롯을 두 벌 만들지 않는다', async () => {
      const workOrderId = await planned();
      const key = randomUUID();

      const first = await call(workOrderId, 100, '1', key).expect(200);
      const again = await call(workOrderId, 100, '1', key).expect(200);

      expect(again.body).toEqual(first.body);
      expect(await slots(workOrderId)).toHaveLength(1);
      expect(await requests(workOrderId)).toHaveLength(1);
    });

    it('배포 — 배포된 W/O 를 다시 배포하면 400 이다', async () => {
      const workOrderId = await planned();
      await call(workOrderId, 100).expect(200);

      // 전이표의 `from` 밖이다 — 409 가 아니라 400 이고 재로드해도 안 풀린다(§1-6).
      const again = await call(workOrderId, 100, '2').expect(400);
      expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
      expect(await slots(workOrderId)).toHaveLength(1);
    });

    it('배포 — 실패하면 슬롯·요청이 하나도 안 남는다', async () => {
      // 소요가 `requested_qty numeric(20,6)` 을 넘게 만들어 라인 INSERT 를 깬다
      // (계획서의 「BOM 라인의 품목을 지운다」는 FK 가 삭제 자체를 막아 성립하지 않는다).
      const workOrderId = await planned({ production_plan_id: ids.overflowPlan, order_qty: 1000000 });

      await call(workOrderId, 1000000).expect(500);

      expect(await slots(workOrderId)).toEqual([]);
      expect(await requests(workOrderId)).toEqual([]);
      const row = await prisma.work_order.findUniqueOrThrow({
        where: { work_order_id: BigInt(workOrderId) },
      });
      expect(row).toMatchObject({ status_code: 'PLANNED', version_no: 1, released_at: null });
    });
  });

  describe('마감 · 취소 (PR ⑥b)', () => {
    const base = '/api/production/work-orders';
    let seq = 0;

    /**
     * 마감 대상 — 배포까지 HTTP 로 돌린 뒤 진행 상태로 옮긴다. 전이표의 `from` 이
     * `COMPLETED`·`IN_PROGRESS` 인데 `IN_PROGRESS` 로 «들어가는» 액션은 세션 열기(I-11)라
     * 아직 없다. 상태만 손으로 바꾸므로 `version_no` 는 배포가 올린 2 그대로다.
     */
    async function closable(lotSize = 100, goodQty?: number): Promise<number> {
      const row = await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-WOC${++seq}`,
          production_plan_id: ids.productionPlan,
          routing_operation_id: ids.routingOperation,
          item_id: ids.item,
          order_qty: 100,
          uom_id: ids.uom,
          status_code: 'PLANNED',
          // 배포 전제 — 라인이 비면 `:release` 가 400 이다(omf-all-around#36).
          production_line_id: ids.productionLine,
          default_wip_location_id: ids.location,
          default_fg_location_id: ids.fgLocation,
          default_scrap_location_id: ids.scrapLocation,
        },
      });
      const workOrderId = Number(row.work_order_id);
      await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ lotSize })
        .expect(200);
      await prisma.work_order.update({
        where: { work_order_id: row.work_order_id },
        data: { status_code: 'IN_PROGRESS' },
      });
      if (goodQty !== undefined) await result(workOrderId, goodQty);
      return workOrderId;
    }

    /** 실적 직접 INSERT(I-7 전) — 붙일 슬롯을 주면 배정 행까지 만든다. */
    async function result(workOrderId: number, goodQty: number, lotId?: bigint): Promise<void> {
      const row = await prisma.production_result.create({
        data: {
          production_result_no: `${PREFIX}-PRC${++seq}`,
          work_order_id: BigInt(workOrderId),
          result_sequence: 1,
          good_qty: goodQty,
          uom_id: ids.uom,
          result_source_code: 'MANUAL',
          occurred_at: new Date('2026-09-06T02:00:00.000Z'),
          worker_id: ids.worker,
          shift_id: ids.shift,
          status_code: 'CONFIRMED',
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });
      if (lotId === undefined) return;
      await prisma.production_result_lot_allocation.create({
        data: {
          production_result_id: row.production_result_id,
          lot_id: lotId,
          allocated_qty: goodQty,
          uom_id: ids.uom,
        },
      });
    }

    const call = (verb: 'close' | 'cancel', workOrderId: number, body: object, etag = '2') =>
      request(app.getHttpServer())
        .post(`${base}/${workOrderId}:${verb}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', etag)
        .send(body);

    const slots = (workOrderId: number) =>
      prisma.lot.findMany({
        where: { source_type_code: LOT_SOURCE, source_id: BigInt(workOrderId) },
        orderBy: { work_order_lot_seq: 'asc' },
      });

    const history = (lotIds: bigint[]) =>
      prisma.lot_lifecycle_history.findMany({
        where: { lot_id: { in: lotIds } },
        orderBy: { lot_lifecycle_history_id: 'asc' },
      });

    it('M1 마디 — 발행 → 배포 → 슬롯 N 개 `WAITING` → 출고요청 1건', async () => {
      const created = await request(app.getHttpServer())
        .post(base)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionPlanId: Number(ids.productionPlan),
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty: 90,
          uomId: Number(ids.uom),
        })
        .expect(201);
      const workOrderId: number = created.body.workOrderId;
      const configured = await request(app.getHttpServer())
        .put(`${base}/${workOrderId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', created.headers.etag)
        .send({
          defaultWipLocationId: Number(ids.location),
          defaultFgLocationId: Number(ids.fgLocation),
          defaultScrapLocationId: Number(ids.scrapLocation),
          // 배포 전제 — 라인이 비면 `:release` 가 400 이다(omf-all-around#36).
          productionLineId: Number(ids.productionLine),
        })
        .expect(200);
      expect(configured.body).toMatchObject({
        defaultWipLocationId: Number(ids.location),
        defaultFgLocationId: Number(ids.fgLocation),
        defaultScrapLocationId: Number(ids.scrapLocation),
        versionNo: created.body.versionNo + 1,
      });

      const released = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(configured.body.versionNo))
        .send({ lotSize: 30 })
        .expect(200);
      expect(released.body).toMatchObject({
        statusCode: 'RELEASED',
        versionNo: Number(configured.body.versionNo) + 1,
      });

      const detail = await request(app.getHttpServer())
        .get(`${base}/${workOrderId}?withPreIssuedLots=true`)
        .set('Cookie', cookie)
        .expect(200);

      expect(detail.body).toMatchObject({ statusCode: 'RELEASED' });
      // 마감 전이라 아웃박스가 비었다 — 계약 ⌜마감 전에는 비어 있다⌝ 라 키 자체가 없다.
      expect(Object.keys(detail.body)).not.toContain('erpMessageQueued');
      expect(detail.body.preIssuedLots).toEqual({ slotCount: 3, withResultCount: 0, withoutResultCount: 3 });
      expect((await slots(workOrderId)).map((lot) => lot.lifecycle_status_code)).toEqual(['WAITING', 'WAITING', 'WAITING']);
      expect(await prisma.material_issue_request.count({ where: { work_order_id: BigInt(workOrderId) } })).toBe(1);
    });

    /** 발행 → 기본 위치·라인 지정 → 배포까지. PQC 시험이 쓰는 최소 경로다. */
    async function releaseWorkOrder(orderQty: number): Promise<number> {
      const created = await request(app.getHttpServer())
        .post(base)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({
          productionPlanId: Number(ids.productionPlan),
          routingOperationId: Number(ids.routingOperation),
          itemId: Number(ids.item),
          orderQty,
          uomId: Number(ids.uom),
        })
        .expect(201);
      const workOrderId: number = created.body.workOrderId;
      const configured = await request(app.getHttpServer())
        .put(`${base}/${workOrderId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', created.headers.etag)
        .send({
          defaultWipLocationId: Number(ids.location),
          defaultFgLocationId: Number(ids.fgLocation),
          defaultScrapLocationId: Number(ids.scrapLocation),
          productionLineId: Number(ids.productionLine),
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(configured.body.versionNo))
        .send({ lotSize: 30 })
        .expect(200);
      return workOrderId;
    }

    /*
     * ⭐ **PQC 검사 의뢰는 배포가 만든다**(omf-all-around#46 · 설계 REQ-OA-0003 opt-in).
     *    그전까지 서버에 PQC 의뢰를 만드는 코드가 없어 P-02-13(POP 제품 검사)이 열릴 대상이
     *    0건이었다 — 이 시험이 그 공백을 막는다.
     */
    it('PQC — 검사 공정을 배포하면 작업지시 대상 의뢰가 선다', async () => {
      await prisma.routing_operation.update({
        where: { routing_operation_id: ids.routingOperation },
        data: { inspection_managed: true },
      });
      const plan = await prisma.inspection_plan.create({
        data: {
          inspection_plan_code: `${PREFIX}-PQC`,
          inspection_plan_name: 'PQC 공정검사',
          inspection_type_code: 'PQC',
          item_id: ids.item,
          process_id: ids.process,
        },
      });
      const planVersion = await prisma.inspection_plan_version.create({
        data: {
          inspection_plan_id: plan.inspection_plan_id,
          plan_version: 1,
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          status_code: 'CONFIRMED',
          inspection_frequency_code: 'EVERY_LOT',
          sampling_method_code: 'SAMPLE_BY_UNIT',
          /* 샘플 10% — **백분율**이다(계약 「샘플 비율(%)」 · 마이그 20260903800000). */
          sampling_ratio: 10,
        },
      });

      try {
        const workOrderId = await releaseWorkOrder(90);

        const requests = await prisma.inspection_request.findMany({
          where: { work_order_id: BigInt(workOrderId) },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          inspection_type_code: 'PQC',
          target_type_code: 'WORK_ORDER',
          target_id: BigInt(workOrderId),
          inspection_plan_version_id: planVersion.inspection_plan_version_id,
          item_id: ids.item,
          /* 공정검사는 실적 «전»이라 LOT·실적이 아직 없다(계약). */
          lot_id: null,
          production_result_id: null,
          status_code: 'REQUESTED',
        });
        /* 90 의 10% = 9. */
        expect(Number(requests[0].target_qty)).toBe(9);

        /* 화면이 그 의뢰를 목록에서 찾을 수 있어야 한다 — P-02-13 이 여는 길이다. */
        const listed = await request(app.getHttpServer())
          .get(`/api/quality/inspection-requests?inspectionTypeCode=PQC&workOrderId=${workOrderId}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(listed.body.items).toHaveLength(1);
        expect(listed.body.items[0]).toMatchObject({
          inspectionTypeCode: 'PQC',
          targetTypeCode: 'WORK_ORDER',
          workOrderId,
          statusCode: 'REQUESTED',
        });
      } finally {
        await prisma.routing_operation.update({
          where: { routing_operation_id: ids.routingOperation },
          data: { inspection_managed: false },
        });
      }
    });

    /* ⛔ 검사 공정이 아니면 의뢰를 만들지 않는다 — 전 공정에 붙으면 현장이 검사에 파묻힌다. */
    it('PQC — 검사 공정이 아니면 의뢰가 서지 않는다', async () => {
      const workOrderId = await releaseWorkOrder(60);

      expect(await prisma.inspection_request.count({ where: { work_order_id: BigInt(workOrderId) } })).toBe(0);
    });

    it('마감 — 열린 세션이 있으면 409 `OPEN_SESSION_EXISTS` 다', async () => {
      const workOrderId = await closable(100, 100);
      await prisma.work_session.create({
        data: {
          work_order_id: BigInt(workOrderId),
          session_no: 1,
          shift_id: ids.shift,
          terminal_id: ids.terminal,
          started_at: new Date('2026-09-06T01:00:00.000Z'),
          // ⭐ `STOPPED` 도 «열린» 것이다 — 판정은 `ended_at IS NULL` 이다(§5-5).
          status_code: 'STOPPED',
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });

      const rejected = await call('close', workOrderId, {}).expect(409);

      expect(rejected.body).toMatchObject({ code: 'OPEN_SESSION_EXISTS' });
      expect(validator('POST /production/work-orders/{workOrderId}:close', 409)(rejected.body)).toBe(true);
      const row = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(row).toMatchObject({ status_code: 'IN_PROGRESS', closed_at: null });
    });

    it('마감 — 세션을 닫으면 마감된다', async () => {
      const workOrderId = await closable(100, 100);
      const session = await prisma.work_session.create({
        data: {
          work_order_id: BigInt(workOrderId),
          session_no: 1,
          shift_id: ids.shift,
          terminal_id: ids.terminal,
          started_at: new Date('2026-09-06T01:00:00.000Z'),
          status_code: 'RUNNING',
          idempotency_key: `${PREFIX}-${randomUUID()}`,
        },
      });
      await call('close', workOrderId, {}).expect(409);

      await prisma.work_session.update({
        where: { work_session_id: session.work_session_id },
        data: { ended_at: new Date('2026-09-06T03:00:00.000Z'), status_code: 'ENDED' },
      });
      const closed = await call('close', workOrderId, {}).expect(200);

      expect(closed.body).toMatchObject({ statusCode: 'CLOSED', versionNo: 3, erpMessageQueued: true });
      expect(closed.body.closedAt).toEqual(expect.any(String));
      expect(validator('POST /production/work-orders/{workOrderId}:close')(closed.body)).toBe(true);
    });

    it('마감 — 실적 없는 슬롯만 `VOIDED` 이고 실적 붙은 슬롯은 남는다 + `lot_lifecycle_history` 에 L2 가 찍힌다', async () => {
      const workOrderId = await closable(50);
      const [attached, empty] = await slots(workOrderId);
      await result(workOrderId, 100, attached.lot_id);

      await call('close', workOrderId, {}).expect(200);

      const after = await slots(workOrderId);
      // ⌜실적이 없는 슬롯만⌝(R82) — 실적이 붙은 슬롯은 `WAITING` 그대로 남는다.
      expect(after.map((lot) => lot.lifecycle_status_code)).toEqual(['WAITING', 'VOIDED']);
      const rows = await history(after.map((lot) => lot.lot_id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        lot_id: empty.lot_id,
        from_lifecycle_status_code: 'WAITING',
        to_lifecycle_status_code: 'VOIDED',
        transition_code: 'L2',
        // I-7 R-2 — 계약 enum 이 L2 에 `WORK_ORDER_CLOSING` 을 못박았다(`WORK_ORDER` 는 L3).
        source_document_type_code: 'WORK_ORDER_CLOSING',
        source_document_id: BigInt(workOrderId),
      });
    });

    it('마감 — 미달·정상·초과 세 갈래가 각각 400/200/400 을 낸다', async () => {
      const [under, normal, over] = await Promise.all([closable(100, 90), closable(100, 100), closable(100, 110)]);

      const missingDisposition = await call('close', under, { reasonCode: 'MATERIAL_SHORTAGE' }).expect(400);
      expect(missingDisposition.body.errors[0]).toMatchObject({
        field: 'remainderDispositionCode',
        code: 'REMAINDER_DISPOSITION_REQUIRED',
      });

      // 정상은 두 칸을 다 비운다 — 그때만 200 이다.
      await call('close', normal, {}).expect(200);

      const missingReason = await call('close', over, {}).expect(400);
      expect(missingReason.body.errors[0]).toMatchObject({ field: 'reasonCode', code: 'REQUIRED' });
      // 초과인데 처분을 실으면 반대쪽 코드가 난다.
      const notAllowed = await call('close', over, { reasonCode: 'OVER_PRODUCTION', remainderDispositionCode: 'CARRY_OVER' }).expect(400);
      expect(notAllowed.body.errors[0]).toMatchObject({ code: 'REMAINDER_DISPOSITION_NOT_ALLOWED' });
    });

    it('마감 — `integration_message` 1행이 `GET /integration/messages` 로 보이고 상태가 `PENDING` 이다', async () => {
      const workOrderId = await closable(100, 100);

      const closed = await call('close', workOrderId, { erpSendItems: ['투입자재'], remarks: '마감 비고' }).expect(200);
      expect(closed.body).toMatchObject({ erpMessageQueued: true, remarks: '마감 비고' });

      const listed = await request(app.getHttpServer())
        .get('/api/integration/messages?createdFrom=2026-01-01T00:00:00.000Z&createdTo=2030-01-01T00:00:00.000Z&interfaceCode=IF-WO-CLOSE-SEND&targetTypeCode=WORK_ORDER')
        .set('Cookie', cookie)
        .expect(200);

      const mine = listed.body.items.filter((item: { targetId: number }) => item.targetId === workOrderId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        statusCode: 'PENDING',
        directionCode: 'OUTBOUND',
        messageKey: `IF-WO-CLOSE-SEND:${closed.body.workOrderNo}`,
        retryCount: 0,
      });
      // 값을 해석하지 않고 그대로 싣는다 — 부속 항목 코드 표기가 아직 없다(§5-6).
      const stored = await prisma.integration_message.findUniqueOrThrow({
        where: { message_key: `IF-WO-CLOSE-SEND:${closed.body.workOrderNo}` },
      });
      expect(stored.payload).toMatchObject({
        header: { workOrderId, goodQty: 100, completionJudgmentCode: 'NORMAL' },
        sendItems: ['투입자재'],
      });
    });

    it('마감 — 마감된 W/O 에 `:cancel` 은 400 이고 500 이 아니다', async () => {
      const workOrderId = await closable(100, 100);
      await call('close', workOrderId, {}).expect(200);

      // ⛔ 전이표가 `CLOSED` 를 `from` 밖으로 막는다 — UPDATE 까지 가면
      //    `trg_work_order_closed_immutable` 이 500 을 낸다.
      const rejected = await call('cancel', workOrderId, { reasonCode: 'PLAN_CHANGE' }, '3').expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('취소 — 슬롯 전건이 `VOIDED` 이고 이력에 L3 가 찍힌다', async () => {
      const workOrderId = await closable(50);
      const before = await slots(workOrderId);
      // 첫 슬롯을 활성으로 옮겨 둔다 — 마감의 집합(`WAITING` 만)보다 넓은지 가르는 자리다.
      await prisma.lot.update({
        where: { lot_id: before[0].lot_id },
        data: { lifecycle_status_code: 'ACTIVE' },
      });

      const cancelled = await call('cancel', workOrderId, { reasonCode: 'PLAN_CHANGE', note: '버려진다' }).expect(200);

      expect(cancelled.body).toMatchObject({ statusCode: 'CANCELLED', versionNo: 3 });
      expect(validator('POST /production/work-orders/{workOrderId}:cancel')(cancelled.body)).toBe(true);
      // `note` 는 담을 칸이 없어 버린다 — `remarks` 에 덧붙이지 않는다(「알려둘 것」).
      expect(cancelled.body.remarks ?? null).toBeNull();
      const after = await slots(workOrderId);
      expect(after.map((lot) => lot.lifecycle_status_code)).toEqual(['VOIDED', 'VOIDED']);
      const rows = await history(after.map((lot) => lot.lot_id));
      expect(rows.map((row) => row.transition_code)).toEqual(['L3', 'L3']);
      // 코어가 집합을 «찾은 순서»로 돈다 — 두 슬롯이 각각 자기 자리에서 왔는지만 본다.
      expect(rows.map((row) => row.from_lifecycle_status_code).sort()).toEqual(['ACTIVE', 'WAITING']);
      const row = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(row.cancellation_reason_code).toBe('PLAN_CHANGE');
    });

    it('취소 — 이미 발행된 출고요청은 그대로 남는다(문의 038)', async () => {
      const workOrderId = await closable(100);

      await call('cancel', workOrderId, { reasonCode: 'CUSTOMER_ORDER_CHANGE' }).expect(200);

      // §2 2단계 기준 1 — 재고·상태를 쓰지 않는 쪽. I-8 이 그 표의 상태 축을 세울 때 함께 정한다.
      const [issued] = await prisma.material_issue_request.findMany({
        where: { work_order_id: BigInt(workOrderId) },
        include: { material_issue_request_line: true },
      });
      expect(issued).toMatchObject({ status_code: 'REGISTERED' });
      expect(issued.material_issue_request_line).toHaveLength(2);
    });

    it('취소 — 사유 코드가 시드 6값 밖이면 400 이다', async () => {
      const workOrderId = await closable(100);

      const rejected = await call('cancel', workOrderId, { reasonCode: 'NOT_A_SEEDED_REASON' }).expect(400);

      expect(rejected.body.errors[0]).toMatchObject({ field: 'reasonCode', code: 'INVALID' });
      const row = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: BigInt(workOrderId) } });
      expect(row).toMatchObject({ status_code: 'IN_PROGRESS', cancellation_reason_code: null });
    });

    it('마감 — If-Match 가 없으면 400, 낡으면 409 다', async () => {
      const workOrderId = await closable(100, 100);

      const missing = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:close`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(missing.status).toBe(400);

      const stale = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:close`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({});
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });

      // 상태가 안 바뀌었음을 못박는다 — 여전히 올바른 토큰 '2' 로는 그대로 마감된다.
      await call('close', workOrderId, {}, '2').expect(200);
    });

    it('취소 — If-Match 가 없으면 400, 낡으면 409 다', async () => {
      const workOrderId = await closable(100);

      const missing = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'PLAN_CHANGE' });
      expect(missing.status).toBe(400);

      const stale = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ reasonCode: 'PLAN_CHANGE' });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });

      // 상태가 안 바뀌었음을 못박는다 — 여전히 올바른 토큰 '2' 로는 그대로 취소된다.
      await call('cancel', workOrderId, { reasonCode: 'PLAN_CHANGE' }, '2').expect(200);
    });

    it('마감 — 같은 Idempotency-Key 재전송은 200 을 되돌려주고 integration_message 는 1행이다', async () => {
      const workOrderId = await closable(100, 100);
      const key = randomUUID();

      const first = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:close`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '2')
        .send({})
        .expect(200);
      const again = await request(app.getHttpServer())
        .post(`${base}/${workOrderId}:close`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .set('If-Match', '2')
        .send({})
        .expect(200);

      expect(again.body).toEqual(first.body);
      const count = await prisma.integration_message.count({
        where: { message_key: `IF-WO-CLOSE-SEND:${first.body.workOrderNo}` },
      });
      expect(count).toBe(1);
    });
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
    // omf-all-around#36 — 배포는 라인을 요구한다. 같은 공장 라인 하나와 어긋난 라인 하나.
    ids.productionLine = (
      await prisma.production_line.create({
        data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '작업지시검사라인' },
      })
    ).production_line_id;
    const otherPlant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '작업지시검사딴공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.otherPlantLine = (
      await prisma.production_line.create({
        data: {
          plant_id: otherPlant.plant_id,
          line_code: `${PREFIX}-LN2`,
          line_name: '작업지시검사딴라인',
        },
      })
    ).production_line_id;
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

    // ⑤b — BOM 소요 산정용 구성 3행. 둘은 이 공정, 하나는 **공정 미지정**(안 담긴다).
    const componentItems = [];
    for (const [suffix, name] of [['A', '원자재갑'], ['B', '원자재을']]) {
      componentItems.push(
        await prisma.item.create({
          data: {
            item_code: `${PREFIX}-CI${suffix}`,
            item_name: name,
            item_type_code: 'RAW_MATERIAL',
            base_uom_id: uom.uom_id,
          },
        }),
      );
    }
    ids.componentItemA = componentItems[0].item_id;
    ids.componentItemB = componentItems[1].item_id;
    await prisma.bom_component.createMany({
      data: [
        { bom_id: bom.bom_id, component_item_id: componentItems[0].item_id, routing_operation_id: operation.routing_operation_id, required_qty: 2, uom_id: uom.uom_id, sequence_no: 1 },
        // 스크랩률이 있어도 소요에 곱하지 않는다(문의 037 · R-18).
        { bom_id: bom.bom_id, component_item_id: componentItems[1].item_id, routing_operation_id: operation.routing_operation_id, required_qty: 0.5, scrap_rate: 0.05, uom_id: uom.uom_id, sequence_no: 2 },
        { bom_id: bom.bom_id, component_item_id: componentItems[0].item_id, routing_operation_id: null, required_qty: 9, uom_id: uom.uom_id, sequence_no: 3 },
      ],
    });

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '작업지시검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '작업지시검사위치',
        location_type_code: 'BIN',
      },
    });
    ids.location = location.location_id;
    const [fg, scrap] = await Promise.all(
      ['FG', 'SCRAP'].map((suffix) => prisma.location.create({
        data: {
          warehouse_id: warehouse.warehouse_id,
          location_code: PREFIX + '-' + suffix,
          location_name: '작업지시검사' + suffix + '위치',
          location_type_code: 'BIN',
        },
      })),
    );
    ids.fgLocation = fg.location_id;
    ids.scrapLocation = scrap.location_id;
    // ⭐ 설비와 작업자를 «같은 숫자 id» 로 심는다 — 배정 유일키가 `resource_type_code` 를 함께
    //    보는지(같은 id 라도 유형이 다르면 배정된다)를 볼 유일한 길이다. 두 시퀀스는 서로
    //    모르므로 값을 못박고, 다음 자동 채번이 부딪히지 않게 시퀀스를 그 뒤로 민다.
    const [maxEquipment, maxWorker] = await Promise.all([
      prisma.equipment.aggregate({ _max: { equipment_id: true } }),
      prisma.worker.aggregate({ _max: { worker_id: true } }),
    ]);
    twinId = (maxEquipment._max.equipment_id ?? 0n) > (maxWorker._max.worker_id ?? 0n)
      ? (maxEquipment._max.equipment_id ?? 0n) + 1n
      : (maxWorker._max.worker_id ?? 0n) + 1n;

    // ⛔ 두 PK 는 `GENERATED ALWAYS` 라 Prisma create 로는 값을 못 넣는다 — 원문 INSERT 로
    //    `OVERRIDING SYSTEM VALUE` 를 써야 한다. 넣은 뒤 시퀀스를 그 값으로 민다.
    await prisma.$executeRawUnsafe(
      `INSERT INTO mdm.worker (worker_id, worker_no, worker_name, business_unit_id, plant_id, status_code)
       OVERRIDING SYSTEM VALUE VALUES (${twinId}, '${PREFIX}-WK', '작업지시검사작업자', ${unit.business_unit_id}, ${plant.plant_id}, 'EMPLOYED')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO mdm.equipment (equipment_id, plant_id, equipment_code, equipment_name, equipment_type_code, status_code)
       OVERRIDING SYSTEM VALUE VALUES (${twinId}, ${plant.plant_id}, '${PREFIX}-EQ', '작업지시검사설비', 'PRESS', 'IN_SERVICE')`,
    );
    for (const [table, column] of [
      ['mdm.worker', 'worker_id'],
      ['mdm.equipment', 'equipment_id'],
    ]) {
      await prisma.$queryRawUnsafe(`SELECT setval(pg_get_serial_sequence('${table}', '${column}'), ${twinId})`);
    }
    const worker = await prisma.worker.findUniqueOrThrow({ where: { worker_id: twinId } });
    ids.worker = worker.worker_id;
    ids.equipment = twinId;
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
    // `work_session` 이 요구하는 NOT NULL 참조 — 중단이 세션을 안 건드리는지 보려면 필요하다.
    const terminal = await prisma.terminal.create({
      data: {
        terminal_code: `${PREFIX}-TM`,
        plant_id: plant.plant_id,
        terminal_type_code: 'POP',
        status_code: 'RUNNING',
      },
    });
    ids.terminal = terminal.terminal_id;

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

    // 목록 GET(PR ②) 전용 — 같은 계획 아래 두 번째 W/O. priority_no 를 낮춰 기본 정렬을 보고,
    // `workOrder` 의 후속으로 걸어 `successorOfWorkOrderId` 가 의존 표를 푸는지 본다.
    const secondWorkOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO2`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 50,
        uom_id: uom.uom_id,
        status_code: 'PLANNED',
        priority_no: 10,
      },
    });
    secondWorkOrderId = Number(secondWorkOrder.work_order_id);
    await prisma.work_order_dependency.create({
      data: { predecessor_work_order_id: workOrder.work_order_id, successor_work_order_id: secondWorkOrder.work_order_id },
    });
    // `releasable=true` 가 이 후보를 통과시키는지 보는 대조군 — 자원 배정은 있고 BLOCK 은 없다
    // (자격 미달은 WARN 뿐이라 통과한다).
    await prisma.work_order_resource_assignment.create({
      data: { work_order_id: secondWorkOrder.work_order_id, resource_type_code: 'WORKER', worker_id: worker.worker_id },
    });

    // `releasable`ⓒ 의 후보 집합 자체(유형)에서 빠지는 긴급 W/O — 계획 필터 스코프 테스트를
    // 건드리지 않게 별도 계획(같은 발주) 아래에 심는다. `productionPlanId` 는 계약 필수 칸이라
    // 계획 없이 심으면 이 파일의 무필터 목록 테스트가 계약 검증에서 깨진다.
    const secondPlan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP2`,
        plan_date: new Date('2026-09-06T00:00:00.000Z'),
        planned_qty: 10,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    const emergencyWorkOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO3`,
        production_plan_id: secondPlan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 10,
        uom_id: uom.uom_id,
        status_code: 'PLANNED',
        work_order_type_code: 'EMERGENCY',
      },
    });
    emergencyWorkOrderId = Number(emergencyWorkOrder.work_order_id);

    // ⑤b 롤백 e2e 전용 — 소요가 `requested_qty numeric(20,6)` 을 넘게 만드는 BOM.
    // (계획서의 「BOM 라인의 품목을 지운다」는 FK 가 삭제 자체를 막아 성립하지 않는다.)
    const overflowBom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOMX`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 0.000001,
        base_uom_id: uom.uom_id,
      },
    });
    await prisma.bom_component.create({
      data: {
        bom_id: overflowBom.bom_id,
        component_item_id: componentItems[0].item_id,
        routing_operation_id: operation.routing_operation_id,
        required_qty: 1000000,
        uom_id: uom.uom_id,
        sequence_no: 1,
      },
    });
    const overflowPlan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PPX`,
        plan_date: new Date('2026-09-06T00:00:00.000Z'),
        planned_qty: 1000000,
        uom_id: uom.uom_id,
        bom_id: overflowBom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    ids.overflowPlan = overflowPlan.production_plan_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '작업지시검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '작업지시검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

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

  /** 만든 행을 역순으로 지운다 — FK 방향 그대로. */
  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    // ⚠ 발행(`POST`)이 만든 W/O 는 번호를 채번이 짓는다(`WO-…`) — 접두어로는 안 잡히므로
    //    계획을 거쳐 함께 건다.
    const orderScope = {
      OR: [
        { work_order_no: { startsWith: PREFIX } },
        { production_plan: { plan_no: { startsWith: PREFIX } } },
      ],
    };
    // 아웃박스는 W/O 를 FK 로 안 걸고 `target_id` 로만 가리킨다 — id 를 먼저 모아 지운다.
    const queued = await prisma.work_order.findMany({ where: orderScope, select: { work_order_id: true } });
    await prisma.integration_message.deleteMany({
      where: { target_type_code: 'WORK_ORDER', target_id: { in: queued.map((row) => row.work_order_id) } },
    });
    await prisma.production_result_lot_allocation.deleteMany({
      where: { production_result: { work_order: orderScope } },
    });
    await prisma.production_result.deleteMany({ where: { work_order: orderScope } });
    await prisma.material_issue_request_line.deleteMany({
      where: { material_issue_request: { work_order: orderScope } },
    });
    await prisma.material_issue_request.deleteMany({ where: { work_order: orderScope } });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    // PQC 의뢰는 W/O 를 FK 로 건다 — W/O 를 지우기 전에 먼저 비운다(omf-all-around#46).
    await prisma.inspection_request.deleteMany({ where: { work_order: orderScope } });
    await prisma.inspection_plan_version.deleteMany({
      where: { inspection_plan: { item: { item_code: { startsWith: PREFIX } } } },
    });
    await prisma.inspection_plan.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.work_order_resource_assignment.deleteMany({ where: { work_order: orderScope } });
    await prisma.work_session.deleteMany({ where: { work_order: orderScope } });
    // FK 가 `work_order` 를 막는다 — 지우기 전에 의존 표를 먼저 비운다.
    await prisma.work_order_dependency.deleteMany({ where: { predecessor_work_order_id: ids.workOrder } });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    // W/O·설비가 라인을 FK 로 잡는다 — 둘을 비운 뒤에 지운다.
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
