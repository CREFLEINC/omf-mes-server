/**
 * 결재함 조회 2건 — `GET /app/approval-requests`(목록) · `GET …/{id}`(상세). 화면은
 * `W-CO-09`(결재함)가 소유한다.
 *
 * ⛔ 등록·활성 전이(③a)와 `:approve`/`:reject`(④)는 이 파일에 없다 — 단계 결재는
 * 표를 직접 밀어 흉내 낸다(코어 `decide()` 를 부르지 않는다).
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
import { ApprovalService } from '../src/core/approval';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRequest, seedRoute } from './approval-request.fixture';

const REQUESTER_ID = 'e2e-approval-requester';
const APPROVER_ID = 'e2e-approval-approver';
const THIRD_PARTY_ID = 'e2e-approval-third-party';
const LOGIN_IDS = [REQUESTER_ID, APPROVER_ID, THIRD_PARTY_ID];
const PASSWORD = '결재함-검사-비밀번호';
const ROLE = 'E2E_APPROVAL_INBOX';
// 목록(`GET /app/approval-requests`)은 W-01-13·W-03-09·W-CO-09 중 하나면 되지만
// 상세(`GET …/{id}`)는 도출표가 W-03-09 «하나뿐»이라 함께 준다(derived-permissions.ts 실측).
const PERMISSIONS = ['W-CO-09', 'W-03-09'];

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

describe('결재함 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvalService: ApprovalService;

  let requesterId: bigint;
  let approverId: bigint;
  let thirdPartyId: bigint;
  let requesterCookie: string[];
  let approverCookie: string[];
  let thirdPartyCookie: string[];

  // 결재선(타입 하나에 활성 한 벌 — ROUTE_AMBIGUOUS 회피)을 테스트별로 나눠 쓴다.
  const routeIds: bigint[] = [];
  const singleApproverTypes = [
    'GOODS_ISSUE_DISPOSAL',
    'GOODS_RECEIPT_CANCEL',
    'SHIPMENT_CANCEL',
    'IQC_SKIP',
    'PRODUCTION_RESULT_CORRECT',
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    approvalService = app.get(ApprovalService);

    await cleanupUsers();

    requesterId = await createUser(REQUESTER_ID);
    approverId = await createUser(APPROVER_ID);
    thirdPartyId = await createUser(THIRD_PARTY_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '결재함검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    for (const id of [requesterId, approverId, thirdPartyId]) {
      await prisma.user_role.create({ data: { app_user_id: id, role_id: role.role_id } });
    }
    requesterCookie = await login(REQUESTER_ID);
    approverCookie = await login(APPROVER_ID);
    thirdPartyCookie = await login(THIRD_PARTY_ID);

    // 승인자 한 명짜리 결재선 — 대상별 검사가 서로 안 섞이게 유형을 나눈다.
    for (const type of singleApproverTypes) {
      routeIds.push(await seedRoute(prisma, type, [approverId]));
    }
    // assignedToMe — 「나」(approverId) 가 있는 요청과 없는 요청을 가르는 결재선 둘.
    routeIds.push(await seedRoute(prisma, 'INVENTORY_ADJUSTMENT', [approverId]));
    routeIds.push(await seedRoute(prisma, 'PURCHASE_ORDER', [thirdPartyId]));
    // pendingOnly+myTurnOnly — 2단계(approver → thirdParty).
    routeIds.push(await seedRoute(prisma, 'GOODS_ISSUE_CANCEL', [approverId, thirdPartyId]));
  });

  afterAll(async () => {
    await cleanupData();
    await cleanupUsers();
    await app.close();
  });

  it('결재함 — 목록이 계약 ApprovalRequest 스키마를 만족한다', async () => {
    const req = await createRequest('GOODS_ISSUE_DISPOSAL', requesterId, 'GOODS_ISSUE', 900001n);
    const res = await request(app.getHttpServer())
      .get(`/api/app/approval-requests?targetTypeCode=GOODS_ISSUE&targetId=900001`)
      .set('Cookie', requesterCookie)
      .expect(200);
    const validate = validator('GET /app/approval-requests');
    expect(validate(res.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(res.body.items.map((i: { approvalRequestId: number }) => i.approvalRequestId)).toContain(
      Number(req.approvalRequestId),
    );

    // `q` — 요청번호 contains.
    const byQ = await request(app.getHttpServer())
      .get(`/api/app/approval-requests?q=${encodeURIComponent(req.approvalRequestNo)}`)
      .set('Cookie', requesterCookie)
      .expect(200);
    expect(byQ.body.items).toHaveLength(1);

    // `requestedAtFrom/To` — 반열림(다음날 00:00Z 미만)이라 오늘 하루는 [today, today] 로 잡힌다.
    const today = new Date().toISOString().slice(0, 10);
    const byDate = await request(app.getHttpServer())
      .get(`/api/app/approval-requests?requestedAtFrom=${today}&requestedAtTo=${today}&q=${encodeURIComponent(req.approvalRequestNo)}`)
      .set('Cookie', requesterCookie)
      .expect(200);
    expect(byDate.body.items).toHaveLength(1);
  });

  it('결재함 — assignedToMe 는 approver_id 가 나인 단계가 있는 요청만 준다', async () => {
    const mine = await createRequest('INVENTORY_ADJUSTMENT', requesterId, 'INVENTORY_ADJUSTMENT', 900021n);
    const notMine = await createRequest('PURCHASE_ORDER', requesterId, 'PURCHASE_ORDER', 900022n);

    const res = await request(app.getHttpServer())
      .get('/api/app/approval-requests?assignedToMe=true')
      .set('Cookie', approverCookie)
      .expect(200);
    const ids = res.body.items.map((i: { approvalRequestId: number }) => i.approvalRequestId);
    expect(ids).toContain(Number(mine.approvalRequestId));
    expect(ids).not.toContain(Number(notMine.approvalRequestId));
  });

  it('결재함 — requestedByMe 는 상신자가 나인 것만 준다', async () => {
    const byRequester = await createRequest('GOODS_RECEIPT_CANCEL', requesterId, 'GOODS_RECEIPT', 900031n);
    const byApprover = await createRequest('GOODS_RECEIPT_CANCEL', approverId, 'GOODS_RECEIPT', 900032n);

    const res = await request(app.getHttpServer())
      .get('/api/app/approval-requests?requestedByMe=true')
      .set('Cookie', requesterCookie)
      .expect(200);
    const ids = res.body.items.map((i: { approvalRequestId: number }) => i.approvalRequestId);
    expect(ids).toContain(Number(byRequester.approvalRequestId));
    expect(ids).not.toContain(Number(byApprover.approvalRequestId));
  });

  it('결재함 — pendingOnly + myTurnOnly 가 「내 결재 대기」다', async () => {
    const req = await createRequest('GOODS_ISSUE_CANCEL', requesterId, 'GOODS_ISSUE', 900041n);

    const before = await request(app.getHttpServer())
      .get('/api/app/approval-requests?pendingOnly=true&myTurnOnly=true')
      .set('Cookie', approverCookie)
      .expect(200);
    expect(before.body.items.map((i: { approvalRequestId: number }) => i.approvalRequestId)).toContain(
      Number(req.approvalRequestId),
    );

    // :approve 는 PR④ 몫이라 «1단계 승인 완료」를 표를 직접 밀어 흉내 낸다 — 이후
    // 「현재 단계」가 2단계(thirdParty)로 넘어가 approver 는 더는 myTurnOnly 에 안 잡힌다.
    await prisma.approval_step.updateMany({
      where: { approval_request_id: req.approvalRequestId, step_no: 1 },
      data: { decision_code: 'APPROVED', decision_at: new Date() },
    });

    const after = await request(app.getHttpServer())
      .get('/api/app/approval-requests?pendingOnly=true&myTurnOnly=true')
      .set('Cookie', approverCookie)
      .expect(200);
    expect(after.body.items.map((i: { approvalRequestId: number }) => i.approvalRequestId)).not.toContain(
      Number(req.approvalRequestId),
    );
  });

  it('결재함 — targetTypeCode + targetId 로 이 문서의 승인 상태를 찾는다', async () => {
    const req = await createRequest('SHIPMENT_CANCEL', requesterId, 'SHIPMENT', 900051n);
    const res = await request(app.getHttpServer())
      .get('/api/app/approval-requests?targetTypeCode=SHIPMENT&targetId=900051')
      .set('Cookie', requesterCookie)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].approvalRequestId).toBe(Number(req.approvalRequestId));
  });

  it('결재함 — 승인자도 상신자도 아니면 상세가 403 이다', async () => {
    const req = await createRequest('IQC_SKIP', requesterId, 'INBOUND_LOT', 900061n);
    await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${req.approvalRequestId}`)
      .set('Cookie', thirdPartyCookie)
      .expect(403);
    // 대조 — 승인자·상신자는 열린다.
    await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${req.approvalRequestId}`)
      .set('Cookie', approverCookie)
      .expect(200);
  });

  it('결재함 — 대상은 displayName("{type} #{id}")·openable=false 를 내리고 screenId 는 키를 생략한다', async () => {
    const req = await createRequest(
      'PRODUCTION_RESULT_CORRECT',
      requesterId,
      'PRODUCTION_RESULT',
      900071n,
    );
    const res = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${req.approvalRequestId}`)
      .set('Cookie', requesterCookie)
      .expect(200);
    expect(res.body.request.target).toMatchObject({
      targetTypeCode: 'PRODUCTION_RESULT',
      targetId: 900071,
      displayName: 'PRODUCTION_RESULT #900071',
      openable: false,
    });
    // 설계 미정 — 문의 019.
    expect(res.body.request.target).not.toHaveProperty('screenId');
  });

  // ⚠ ApprovalStep 에는 approverIsActive 가 없다(계약 실측 — 그 칸은 ApprovalRouteStep
  // 전용이다). approval_step.approver_id 는 NOT NULL FK 라 approverName 은 required
  // 그대로 항상 있다 — I-1.md §6-3 은 이 스키마 얘기가 아니다.
  it('결재함 — ApprovalStep 은 approverName 이 항상 있고 결재 전 단계는 decisionCode 키를 생략한다', async () => {
    const req = await createRequest('GOODS_ISSUE_DISPOSAL', requesterId, 'GOODS_ISSUE', 900081n);
    const res = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${req.approvalRequestId}`)
      .set('Cookie', requesterCookie)
      .expect(200);
    const validate = validator('GET /app/approval-requests/{approvalRequestId}');
    expect(validate(res.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(res.body.steps[0].approverName).toBeTruthy();
    expect(res.body.steps[0]).not.toHaveProperty('decisionCode');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function createRequest(
    approvalTypeCode: string,
    requestedBy: bigint,
    targetTypeCode: string,
    targetId: bigint,
  ) {
    return seedRequest(prisma, approvalService, { approvalTypeCode, requestedBy, targetTypeCode, targetId });
  }

  async function createUser(loginId: string): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    return user.app_user_id;
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

  async function cleanupData(): Promise<void> {
    const requests = await prisma.approval_request.findMany({
      where: { approval_request_no: { startsWith: 'AP-E2E-' } },
      select: { approval_request_id: true },
    });
    const requestIds = requests.map((r) => r.approval_request_id);
    await prisma.approval_step.deleteMany({ where: { approval_request_id: { in: requestIds } } });
    await prisma.approval_request.deleteMany({ where: { approval_request_id: { in: requestIds } } });
    if (routeIds.length > 0) {
      await prisma.approval_route_step.deleteMany({ where: { approval_route_id: { in: routeIds } } });
      await prisma.approval_route.deleteMany({ where: { approval_route_id: { in: routeIds } } });
    }
  }

  async function cleanupUsers(): Promise<void> {
    for (const loginId of LOGIN_IDS) {
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
