/**
 * 결재선 — 화면 `W-06-15`.
 *
 * ⭐ 이 스위트가 못 박는 규칙 — 활성 결재선은 (approvalTypeCode, businessUnitId) 로 한
 * 벌뿐이다 · 단계 0개인 결재선은 되살릴 수 없다 · 중지에는 거부 조건이 없다(J-9).
 *
 * 결재선에는 이름·제목 같은 문자열 칸이 없어 PREFIX 로 걸러 지울 수 없다 — 만든
 * approvalRouteId 를 직접 모아 afterAll 에서 지운다(§ 도우미 cleanup 참고).
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

const LOGIN_ID = 'e2e-approval-route-probe';
/** 결재선 정의 권한(W-06-15)이 없는 사용자 — 403 검사용. */
const READER_ID = 'e2e-approval-route-reader';
const PASSWORD = '결재선-검사-비밀번호';
const ROLE = 'E2E_APPROVAL_ROUTE';
const READER_ROLE = 'E2E_APPROVAL_ROUTE_READER';
const PERMISSION = 'W-06-15';
const LE_CODE = 'APR-E2E-LE';
const BU1_CODE = 'APR-E2E-BU1';
const BU2_CODE = 'APR-E2E-BU2';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

/** 계약 `ApprovalRoute` 에서 이 검사가 만지는 칸만 추린 형태. */
interface RouteBody {
  approvalRouteId: number;
  approvalTypeCode: string;
  businessUnitId: number | null;
  isActive: boolean;
  stepCount: number;
  inProgressCount: number;
  versionNo?: number;
}

interface StepBody {
  approvalRouteStepId: number;
  stepNo: number;
  approverTypeCode: string;
  approverUserId: number | null;
  approverName?: string;
  approverIsActive: boolean;
}

describe('결재선 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let readerCookie: string[];
  let businessUnit1: bigint;
  let businessUnit2: bigint;
  let activeApproverId: bigint;
  let inactiveApproverId: bigint;
  const createdRouteIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: LE_CODE,
        legal_entity_name: '결재선검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const bu1 = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: BU1_CODE, business_unit_name: '결재선검사사업부1' },
    });
    const bu2 = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: BU2_CODE, business_unit_name: '결재선검사사업부2' },
    });
    businessUnit1 = bu1.business_unit_id;
    businessUnit2 = bu2.business_unit_id;

    const activeApprover = await prisma.app_user.create({
      data: { login_id: 'e2e-approval-route-approver-active', user_name: '결재선검사승인자', status_code: 'EMPLOYED' },
    });
    activeApproverId = activeApprover.app_user_id;
    const inactiveApprover = await prisma.app_user.create({
      data: {
        login_id: 'e2e-approval-route-approver-inactive',
        user_name: '결재선검사중지승인자',
        status_code: 'EMPLOYED',
        is_active: false,
      },
    });
    inactiveApproverId = inactiveApprover.app_user_id;

    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '결재선검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '결재선검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: PERMISSION } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);

    const reader = await prisma.app_user.create({
      data: { login_id: READER_ID, user_name: '결재선권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: reader.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const readerRole = await prisma.role.create({ data: { role_code: READER_ROLE, role_name: '결재선읽기전용' } });
    await prisma.user_role.create({ data: { app_user_id: reader.app_user_id, role_id: readerRole.role_id } });
    readerCookie = await login(READER_ID);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('결재선 — 목록이 유형·사업부·activeOnly 로 걸린다', async () => {
    const a = await create('GOODS_ISSUE_DISPOSAL', Number(businessUnit1));
    const b = await create('GOODS_ISSUE_DISPOSAL', Number(businessUnit2));
    const c = await create('INVENTORY_ADJUSTMENT', Number(businessUnit1));
    await deactivate(c.id, c.etag);

    const byTypeAndBu = await list(`approvalTypeCode=GOODS_ISSUE_DISPOSAL&businessUnitId=${businessUnit1}`);
    expect(byTypeAndBu.items.map((r) => r.approvalRouteId)).toEqual([a.id]);
    expect(byTypeAndBu.items.map((r) => r.approvalRouteId)).not.toContain(b.id);

    const activeOnly = await list('approvalTypeCode=INVENTORY_ADJUSTMENT&activeOnly=true');
    expect(activeOnly.items.map((r) => r.approvalRouteId)).not.toContain(c.id);

    // ?q 는 approval_type_code 의 부분일치다(#184 리뷰 Minor ③) — 표시명 원천이 없다.
    const byQ = await list(`q=GOODS_ISSUE_DISPOSAL&businessUnitId=${businessUnit1}`);
    expect(byQ.items.map((r) => r.approvalRouteId)).toContain(a.id);
  });

  it('결재선 — 상세가 ETag 를 헤더로만 내린다(본문에 versionNo 가 없다)', async () => {
    const created = await create('PURCHASE_ORDER', null);
    const response = await request(app.getHttpServer())
      .get(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.body.versionNo).toBeUndefined();
  });

  it('결재선 — 등록 응답이 계약 ApprovalRoute 스키마를 만족한다', async () => {
    const response = await post({ approvalTypeCode: 'INBOUND_RECEIPT_CANCEL' }).expect(201);
    createdRouteIds.push(response.body.approvalRouteId);
    const validate = validator('POST /app/approval-routes', 201);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('결재선 — 같은 (유형, 사업부) 재등록은 400 UNIQUE_VIOLATION 이다', async () => {
    await create('GOODS_RECEIPT_CANCEL', Number(businessUnit1));
    const rejected = await post({ approvalTypeCode: 'GOODS_RECEIPT_CANCEL', businessUnitId: Number(businessUnit1) }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'UNIQUE_VIOLATION' });
  });

  it('결재선 — 같은 Idempotency-Key 재전송도 같은 ETag 를 준다(201)', async () => {
    const idemKey = key();
    const payload = { approvalTypeCode: 'GOODS_ISSUE_CANCEL' };
    const first = await request(app.getHttpServer())
      .post('/api/app/approval-routes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(201);
    createdRouteIds.push(first.body.approvalRouteId);
    const second = await request(app.getHttpServer())
      .post('/api/app/approval-routes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idemKey)
      .send(payload)
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('결재선 — If-Match 없이 PUT 하면 400 이다', async () => {
    const created = await create('SHIPMENT_CANCEL', Number(businessUnit2));
    await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ businessUnitId: Number(businessUnit2) })
      .expect(400);
  });

  it('결재선 — 낡은 If-Match 로 PUT 하면 409 다', async () => {
    const created = await create('IQC_SKIP', null);
    await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', created.etag)
      .send({})
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', created.etag)
      .send({})
      .expect(409);
    expect(rejected.body.conflictCause).toBe('user');
  });

  it('결재선 — 같은 Idempotency-Key 재전송은 같은 응답을 준다', async () => {
    const created = await create('PRODUCTION_RESULT_CORRECT', Number(businessUnit1));
    const idemKey = key();
    const first = await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idemKey)
      .set('If-Match', created.etag)
      .send({ businessUnitId: Number(businessUnit1) })
      .expect(200);
    const second = await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idemKey)
      .set('If-Match', created.etag)
      .send({ businessUnitId: Number(businessUnit1) })
      .expect(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('결재선 — 단계 0개인 결재선을 :activate 하면 400 LINE_REQUIRED 다', async () => {
    const created = await create('GOODS_ISSUE_DISPOSAL', null);
    const deactivated = await deactivate(created.id, created.etag);
    const rejected = await request(app.getHttpServer())
      .post(`/api/app/approval-routes/${created.id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', deactivated.etag)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'LINE_REQUIRED' });
  });

  it('결재선 — :deactivate 한 뒤 :activate 하면 다시 활성이다', async () => {
    const created = await create('INVENTORY_ADJUSTMENT', Number(businessUnit2));
    await replaceSteps(created.id, created.etag, [{ approverTypeCode: 'USER', approverUserId: Number(activeApproverId) }]);

    const afterDeactivate = await deactivate(created.id, await etagOf(created.id));
    expect(afterDeactivate.body.isActive).toBe(false);

    const afterActivate = await request(app.getHttpServer())
      .post(`/api/app/approval-routes/${created.id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', afterDeactivate.etag)
      .expect(200);
    expect(afterActivate.body.isActive).toBe(true);
  });

  it('결재선 — 권한 없는 사용자의 PUT 은 403 이다(500 이 아니다)', async () => {
    const created = await create('GOODS_RECEIPT_CANCEL', Number(businessUnit2));
    await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}`)
      .set('Cookie', readerCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', created.etag)
      .send({})
      .expect(403);
  });

  it('단계 — PUT …/steps 는 부모 version_no 를 올리고 새 ETag 를 준다(선례 withBumpedItem)', async () => {
    const created = await create('INBOUND_RECEIPT_CANCEL', Number(businessUnit1));
    const response = await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${created.id}/steps`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', created.etag)
      .send({
        steps: [
          { approverTypeCode: 'USER', approverUserId: Number(activeApproverId) },
          { approverTypeCode: 'USER', approverUserId: Number(inactiveApproverId) },
        ],
      })
      .expect(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.headers.etag).not.toBe(created.etag);
    const validatePut = validator('PUT /app/approval-routes/{approvalRouteId}/steps');
    expect(validatePut(response.body)).toBe(true);
    expect(validatePut.errors ?? []).toEqual([]);

    const stepsResponse = await request(app.getHttpServer())
      .get(`/api/app/approval-routes/${created.id}/steps`)
      .set('Cookie', cookie)
      .expect(200);
    const validateGet = validator('GET /app/approval-routes/{approvalRouteId}/steps');
    expect(validateGet(stepsResponse.body)).toBe(true);
    expect(validateGet.errors ?? []).toEqual([]);
    const items: StepBody[] = stepsResponse.body.items;
    const activeStep = items.find((s) => s.approverUserId === Number(activeApproverId));
    const inactiveStep = items.find((s) => s.approverUserId === Number(inactiveApproverId));
    expect(activeStep?.approverName).toBeDefined();
    expect(activeStep?.approverIsActive).toBe(true);
    expect(inactiveStep?.approverIsActive).toBe(false);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function post(payload: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/app/approval-routes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(payload);
  }

  async function create(
    approvalTypeCode: string,
    businessUnitId: number | null,
  ): Promise<{ id: number; etag: string }> {
    const payload: Record<string, unknown> = { approvalTypeCode };
    if (businessUnitId !== null) payload.businessUnitId = businessUnitId;
    const created = await post(payload).expect(201);
    const id = created.body.approvalRouteId as number;
    createdRouteIds.push(id);
    return { id, etag: created.headers.etag as string };
  }

  async function etagOf(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/approval-routes/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function deactivate(id: number, etag: string): Promise<{ body: RouteBody; etag: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/app/approval-routes/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    return { body: response.body, etag: response.headers.etag };
  }

  async function replaceSteps(
    id: number,
    etag: string,
    steps: { approverTypeCode: string; approverUserId?: number }[],
  ): Promise<void> {
    await request(app.getHttpServer())
      .put(`/api/app/approval-routes/${id}/steps`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ steps })
      .expect(200);
  }

  async function list(query: string): Promise<{ items: RouteBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/approval-routes?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /app/approval-routes');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
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

  async function cleanup(): Promise<void> {
    if (createdRouteIds.length > 0) {
      await prisma.approval_route_step.deleteMany({
        where: { approval_route_id: { in: createdRouteIds.map((id) => BigInt(id)) } },
      });
      await prisma.approval_route.deleteMany({
        where: { approval_route_id: { in: createdRouteIds.map((id) => BigInt(id)) } },
      });
      createdRouteIds.length = 0;
    }
    for (const id of [
      LOGIN_ID,
      READER_ID,
      'e2e-approval-route-approver-active',
      'e2e-approval-route-approver-inactive',
    ]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.approval_route_step.deleteMany({ where: { approver_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const code of [ROLE, READER_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: code } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.user_role.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
    // 정상 실행이면 위에서 이미 다 지워 아래는 0행이다 — 중간에 죽은 이전 실행의
    // 잔여물만 여기서 잡는다(그때는 createdRouteIds 가 이번 프로세스에 비어 있다).
    const bu = await prisma.business_unit.findMany({
      where: { business_unit_code: { in: [BU1_CODE, BU2_CODE] } },
      select: { business_unit_id: true },
    });
    if (bu.length > 0) {
      const businessUnitIds = bu.map((b) => b.business_unit_id);
      const leftoverRoutes = await prisma.approval_route.findMany({
        where: { business_unit_id: { in: businessUnitIds } },
        select: { approval_route_id: true },
      });
      const leftoverIds = leftoverRoutes.map((r) => r.approval_route_id);
      await prisma.approval_route_step.deleteMany({ where: { approval_route_id: { in: leftoverIds } } });
      await prisma.approval_route.deleteMany({ where: { approval_route_id: { in: leftoverIds } } });
      await prisma.business_unit.deleteMany({ where: { business_unit_code: { in: [BU1_CODE, BU2_CODE] } } });
    }
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: LE_CODE } });
  }
});
