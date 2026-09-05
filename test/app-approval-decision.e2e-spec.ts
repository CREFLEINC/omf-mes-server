/**
 * 결재 2건 — `POST …:approve` · `POST …:reject`. 화면은 `W-CO-09`(결재함)가 소유한다.
 *
 * ⛔ 결재함 «조회»는 `app-approval-request.e2e-spec.ts` 에 있다 — 한 파일에 얹지 않는다.
 * 상신(`:request-approval`)은 I-2 몫이라 요청 행은 픽스처가 코어로 만든다.
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

const REQUESTER_ID = 'e2e-decision-requester';
const FIRST_ID = 'e2e-decision-first';
const SECOND_ID = 'e2e-decision-second';
const OUTSIDER_ID = 'e2e-decision-outsider';
const LOGIN_IDS = [REQUESTER_ID, FIRST_ID, SECOND_ID, OUTSIDER_ID];
const PASSWORD = '결재-검사-비밀번호';
const ROLE = 'E2E_APPROVAL_DECISION';
// `:approve`/`:reject` 는 도출표가 W-03-09 하나뿐이고, 상세 GET(ETag 를 여기서 받는다)도
// 같다. 결재함 목록은 안 부르지만 화면 한 벌을 그대로 준다(derived-permissions.ts 실측).
const PERMISSIONS = ['W-03-09', 'W-CO-09'];

// 2단계(first → second) 결재선을 태울 유형과 1단계 유형을 나눈다 — 한 유형에 활성
// 결재선은 한 벌뿐이다(ROUTE_AMBIGUOUS).
const TWO_STEP = 'GOODS_ISSUE_DISPOSAL';
const TWO_STEP_REJECT = 'GOODS_ISSUE_CANCEL';
const ONE_STEP = 'INVENTORY_ADJUSTMENT';

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

interface Detail {
  request: { statusCode: string; currentStepNo: number | null; totalStepNo: number };
  steps: { stepNo: number; decisionCode?: string; decisionComment?: string; isCurrent: boolean }[];
}

describe('결재 승인·반려 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvalService: ApprovalService;

  let requesterId: bigint;
  let firstId: bigint;
  let secondId: bigint;
  let requesterCookie: string[];
  let firstCookie: string[];
  let secondCookie: string[];
  let outsiderCookie: string[];

  const routeIds: bigint[] = [];
  let targetSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    approvalService = app.get(ApprovalService);

    await cleanupUsers();

    requesterId = await createUser(REQUESTER_ID);
    firstId = await createUser(FIRST_ID);
    secondId = await createUser(SECOND_ID);
    const outsiderId = await createUser(OUTSIDER_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '결재검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    for (const id of [requesterId, firstId, secondId, outsiderId]) {
      await prisma.user_role.create({ data: { app_user_id: id, role_id: role.role_id } });
    }
    requesterCookie = await login(REQUESTER_ID);
    firstCookie = await login(FIRST_ID);
    secondCookie = await login(SECOND_ID);
    outsiderCookie = await login(OUTSIDER_ID);

    routeIds.push(await seedRoute(prisma, TWO_STEP, [firstId, secondId]));
    routeIds.push(await seedRoute(prisma, TWO_STEP_REJECT, [firstId, secondId]));
    routeIds.push(await seedRoute(prisma, ONE_STEP, [firstId]));
  });

  afterAll(async () => {
    await cleanupData();
    await cleanupUsers();
    await app.close();
  });

  it('승인 — 1단계 승인 뒤에도 요청은 PENDING 이다(진행중 1/2)', async () => {
    const id = await createRequest(TWO_STEP);
    const response = await approve(id, await etagOf(id, firstCookie), firstCookie, {
      comment: '수량 확인함',
    });

    expect(response.status).toBe(200);
    const validate = validator('POST /app/approval-requests/{approvalRequestId}:approve');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const body = response.body as Detail;
    expect(body.request.statusCode).toBe('PENDING');
    expect(body.request.currentStepNo).toBe(2);
    expect(body.steps[0].decisionCode).toBe('APPROVED');
    expect(body.steps[0].decisionComment).toBe('수량 확인함');
    expect(body.steps.map((step) => step.isCurrent)).toEqual([false, true]);
  });

  it('승인 — 마지막 단계 승인이면 APPROVED 이고 ETag 가 오른다', async () => {
    const id = await createRequest(TWO_STEP);
    const first = await approve(id, await etagOf(id, firstCookie), firstCookie);
    expect(first.status).toBe(200);

    const second = await approve(id, first.headers.etag as string, secondCookie);
    expect(second.status).toBe(200);
    expect(Number(second.headers.etag)).toBeGreaterThan(Number(first.headers.etag));

    const body = second.body as Detail;
    expect(body.request.statusCode).toBe('APPROVED');
    expect(body.request).toHaveProperty('currentStepNo', null);
    expect(body.steps.map((step) => step.decisionCode)).toEqual(['APPROVED', 'APPROVED']);
  });

  it('승인 — 내 차례가 아니면 400 NOT_YOUR_TURN 이다', async () => {
    const id = await createRequest(TWO_STEP);
    const rejected = await approve(id, await etagOf(id, secondCookie), secondCookie);

    expect(rejected.status).toBe(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'NOT_YOUR_TURN' });
  });

  it('승인 — 의견은 선택이다(본문 없이도 200)', async () => {
    const id = await createRequest(ONE_STEP);
    // 본문을 아예 싣지 않는다 — 계약 `requestBody.required: false`.
    const response = await request(app.getHttpServer())
      .post(`/api/app/approval-requests/${id}:approve`)
      .set('Cookie', firstCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', await etagOf(id, firstCookie));

    expect(response.status).toBe(200);
    expect((response.body as Detail).request.statusCode).toBe('APPROVED');
    expect(response.body.steps[0]).not.toHaveProperty('decisionComment');
  });

  it('반려 — 의견을 비우면 400 이다', async () => {
    const id = await createRequest(TWO_STEP_REJECT);
    const etag = await etagOf(id, firstCookie);

    const missing = await reject(id, etag, firstCookie, {} as { comment: string });
    expect(missing.status).toBe(400);
    expect(missing.body.errors[0]).toMatchObject({ field: 'comment', code: 'REQUIRED' });

    const empty = await reject(id, etag, firstCookie, { comment: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'comment', code: 'RANGE' });
  });

  it('반려 — 한 단계 반려로 요청이 REJECTED 가 된다', async () => {
    const id = await createRequest(TWO_STEP_REJECT);
    const response = await reject(id, await etagOf(id, firstCookie), firstCookie, {
      comment: '수량 근거가 부족합니다',
    });

    expect(response.status).toBe(200);
    const body = response.body as Detail;
    expect(body.request.statusCode).toBe('REJECTED');
    expect(body.request).toHaveProperty('currentStepNo', null);
    expect(body.steps[0].decisionCode).toBe('REJECTED');
    // 뒤 단계는 결재된 적이 없다 — 「대기」는 값이 아니라 키의 부재다(계약).
    expect(body.steps[1]).not.toHaveProperty('decisionCode');
  });

  it('반려 — 반려된 요청에 다시 결재하면 400 STATE_LOCKED 다', async () => {
    const id = await createRequest(TWO_STEP_REJECT);
    const rejection = await reject(id, await etagOf(id, firstCookie), firstCookie, {
      comment: '다시 올려 주세요',
    });
    expect(rejection.status).toBe(200);

    // 2단계 승인자가 «새» ETag 로 불러도 상태가 막는다 — 재로드해도 풀리지 않는 400 이다.
    const again = await approve(id, rejection.headers.etag as string, secondCookie);
    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('⭐ 승인은 자물쇠만 푼다 — 대상 문서의 어떤 행도 바뀌지 않는다(J-8)', async () => {
    const id = await createRequest(TWO_STEP, 'GOODS_ISSUE');
    const before = await targetCounts();

    const response = await approve(id, await etagOf(id, firstCookie), firstCookie);
    expect(response.status).toBe(200);

    // 승인은 `approval_request.status_code`·`approval_step` 만 바꾼다 — 전기·출고·조정
    // 반영은 대상 화면의 `:post` 가 따로 한다(공유계약 J-8).
    expect(await targetCounts()).toEqual(before);
  });

  it('⭐ 원장이 움직이지 않는다 — inventory_transaction 이 0건 그대로다', async () => {
    const id = await createRequest(TWO_STEP);
    const before = await prisma.inventory_transaction.count();

    const first = await approve(id, await etagOf(id, firstCookie), firstCookie);
    const second = await approve(id, first.headers.etag as string, secondCookie);
    expect(second.status).toBe(200);
    expect((second.body as Detail).request.statusCode).toBe('APPROVED');

    // 최종 승인까지 가도 원장은 한 줄도 늘지 않는다.
    expect(await prisma.inventory_transaction.count()).toBe(before);
  });

  it('동시 결재 — 낡은 If-Match 를 쓴 뒤쪽이 409 다', async () => {
    const id = await createRequest(TWO_STEP);
    const stale = await etagOf(id, firstCookie);

    expect((await approve(id, stale, firstCookie)).status).toBe(200);

    // 1단계 승인이 version_no 를 올렸다 — 같은 화면을 들고 있던 2단계 승인자는 재로드해야 한다.
    const late = await approve(id, stale, secondCookie);
    expect(late.status).toBe(409);
  });

  it('같은 Idempotency-Key 재전송은 decision_at·decision_comment 를 덮지 않는다', async () => {
    const id = await createRequest(ONE_STEP);
    const etag = await etagOf(id, firstCookie);
    const key = randomUUID();
    const body = { comment: '첫 의견' };

    const first = await approve(id, etag, firstCookie, body, key);
    expect(first.status).toBe(200);
    const decidedAt = await decisionAtOf(id);

    const second = await approve(id, etag, firstCookie, body, key);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
    // 재전송은 코어를 다시 타지 않는다 — 결재 시각·의견이 그대로다.
    expect((await decisionAtOf(id))?.getTime()).toBe(decidedAt?.getTime());
  });

  it('승인 — 결재선에 없는 사용자는 403 이다', async () => {
    const id = await createRequest(TWO_STEP);
    // 기능 권한(W-03-09)은 있으나 이 요청의 결재선에 없다 — 차례 문제가 아니다.
    const etag = await etagOf(id, requesterCookie);
    const rejected = await approve(id, etag, outsiderCookie);

    expect(rejected.status).toBe(403);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function createRequest(approvalTypeCode: string, targetTypeCode = 'GOODS_ISSUE') {
    targetSeq += 1;
    const seeded = await seedRequest(prisma, approvalService, {
      approvalTypeCode,
      requestedBy: requesterId,
      targetTypeCode,
      targetId: BigInt(910000 + targetSeq),
      reason: 'e2e 결재 검사',
    });
    return Number(seeded.approvalRequestId);
  }

  async function etagOf(id: number, cookie: string[]): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag as string;
  }

  function approve(
    id: number,
    etag: string,
    cookie: string[],
    body?: { comment: string },
    key = randomUUID(),
  ) {
    return decide('approve', id, etag, cookie, body, key);
  }

  function reject(id: number, etag: string, cookie: string[], body: { comment: string }) {
    return decide('reject', id, etag, cookie, body, randomUUID());
  }

  function decide(
    action: 'approve' | 'reject',
    id: number,
    etag: string,
    cookie: string[],
    body: object | undefined,
    key: string,
  ) {
    return request(app.getHttpServer())
      .post(`/api/app/approval-requests/${id}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', etag)
      .send(body ?? {});
  }

  /** 대상 문서 쪽 표들의 행 수 — 승인이 한 줄도 건드리지 않는다는 것을 여기서 본다. */
  async function targetCounts(): Promise<Record<string, number>> {
    const [goodsIssue, adjustment, adjustmentLine] = await Promise.all([
      prisma.goods_issue.count(),
      prisma.inventory_adjustment.count(),
      prisma.inventory_adjustment_line.count(),
    ]);
    return { goodsIssue, adjustment, adjustmentLine };
  }

  async function decisionAtOf(id: number): Promise<Date | null> {
    const step = await prisma.approval_step.findFirst({
      where: { approval_request_id: id, step_no: 1 },
      select: { decision_at: true },
    });
    return step?.decision_at ?? null;
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
    // ⛔ 접두어(`AP-`)로 잡지 않는다 — 채번 코어가 `AP-E2E-` 리터럴을 없앴고(I-2 PR ①),
    //    접두어로 쓸면 PR ⑤ 의 P/O 상신 e2e 가 남긴 행까지 지우려다
    //    `purchase_order_approval_request_id_fkey` 위반으로 이 스위트가 깨진다.
    const users = await prisma.app_user.findMany({ where: { login_id: { in: LOGIN_IDS } } });
    const requests = await prisma.approval_request.findMany({
      where: { requested_by: { in: users.map((user) => user.app_user_id) } },
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
