/**
 * W/O 조회 — 상세 `GET /production/work-orders/{workOrderId}`(ETag) + 4M 계획 배정 목록
 * `GET …/{workOrderId}/resource-plans`(I-6 PR ①).
 *
 * 4M 계획 배정 추가·해제(`POST`/`DELETE`)와 유효성 점검 `GET …/validation`(I-6 PR ③),
 * 발행 `POST`·수정 `PUT`·중단 `:hold`·재개 `:resume`(I-6 PR ④)을 잇는다.
 *
 * ⛔ 계약이 403 을 선언한 것은 `validation` 하나뿐이라 그 자리만 권한 가드가 본다 — 나머지
 *   넷은 로그인 세션만으로 통과한다. 그래서 사용자가 둘이다(권한 있음·없음).
 * ⭐ 마스터 픽스처는 **직접 INSERT** 한다 — 시드가 얇아(품목·공정·라우팅·BOM·작업자·근무조
 *   0행) 이 스위트가 다 심는다. 배포(`:release`)는 ⑤b 라 `RELEASED` 도 직접 심는다.
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
 * 계약이 403 을 선언한 다섯 자리의 화면 권한 — `derived-permissions.ts` 가 계약에서 도출한
 * 값이다(`validation`·`PUT` = `W-02-03` · `POST` = `W-02-02` · `:hold`/`:resume` = `P-02-10`).
 */
const PERMISSIONS = ['W-02-03', 'W-02-02', 'P-02-10'];
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

      expect(validator('GET /production/work-orders')(response.body)).toBe(true);
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
    await prisma.production_result_lot_allocation.deleteMany({
      where: { production_result: { work_order: orderScope } },
    });
    await prisma.production_result.deleteMany({ where: { work_order: orderScope } });
    await prisma.lot.deleteMany({ where: plantScope });
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
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
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
