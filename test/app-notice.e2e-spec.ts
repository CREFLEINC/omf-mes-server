/**
 * 공지 — 화면 `W-CO-04`.
 *
 * ⭐ 이 도메인의 규칙 셋을 못 박는다 — 상태는 파생이다 · 게시하면 본문이 잠긴다 ·
 * 「확인」과 「확인 없이 닫음」과 「아무것도 안 함」은 서로 다른 상태다.
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

const LOGIN_ID = 'e2e-notice-probe';
/** 작성 권한(W-CO-04)은 없고 읽기·확인 권한(W-CO-05)만 있는 둘째 사용자. */
const READER_ID = 'e2e-notice-reader';
const PASSWORD = '공지-검사-비밀번호';
const PREFIX = 'NOTICE-E2E';
const ROLE = 'E2E_NOTICE';
const READER_ROLE = 'E2E_NOTICE_READER';
const PERMISSIONS = ['W-CO-04', 'W-CO-05'];

const today = (): string => new Date().toISOString().slice(0, 10);
const shift = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

/** 계약 `Notice` 에서 이 검사가 만지는 칸만 추린 형태. */
interface NoticeBody {
  noticeId: number;
  title: string;
  statusCode: string;
  endDate?: string;
  publishedAt?: string;
  acknowledgedCount: number;
  targetCount: number | null;
}

describe('공지 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let readerCookie: string[];
  let otherUserId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '공지검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: READER_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    otherUserId = other.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const readerRole = await prisma.role.create({
      data: { role_code: READER_ROLE, role_name: '공지읽기용' },
    });
    await prisma.role_permission.create({
      data: { role_id: readerRole.role_id, permission_code: 'W-CO-05' },
    });
    await prisma.user_role.create({
      data: { app_user_id: other.app_user_id, role_id: readerRole.role_id },
    });
    readerCookie = await login(READER_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '공지검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 작성 권한이 없으면 403 이다 — 읽기 권한만으로는 못 쓴다', async () => {
    await request(app.getHttpServer())
      .post('/api/app/notices')
      .set('Cookie', readerCookie)
      .set('Idempotency-Key', key())
      .send(body('막힘'))
      .expect(403);
  });

  it('⛔ 1차에 없는 범위는 400 이다 — SCOPE_NOT_SUPPORTED', async () => {
    const rejected = await post(body('범위', { scopeCode: 'BUSINESS_UNIT' })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'scopeCode',
      code: 'SCOPE_NOT_SUPPORTED',
    });
  });

  it('⛔ 작업지시 범위인데 작업지시가 없으면 400(PAIR)이다', async () => {
    const rejected = await post(body('짝', { scopeCode: 'WORK_ORDER' })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'targetWorkOrderId',
      code: 'PAIR',
    });
  });

  it('⭐ 작성하면 DRAFT 다 — 상태는 저장이 아니라 파생이다', async () => {
    const { id } = await create('초안');
    const notice = await detail(id);
    expect(notice.statusCode).toBe('DRAFT');
    // ⛔ 계약이 publishedAt 을 널 불가로 선언했다 — 게시 전에는 칸이 아예 없다.
    expect(notice.publishedAt).toBeUndefined();
    // 물리 컬럼을 읽지 않는다는 것을 함께 못 박는다 — 컬럼은 기본값 그대로다.
    const row = await prisma.notice.findUniqueOrThrow({ where: { notice_id: id } });
    expect(row.status_code).toBe('DRAFT');
  });

  it('⭐ 게시하면 PUBLISHED 이고, 시작일이 미래면 SCHEDULED 다', async () => {
    const now = await create('지금', { startDate: today() });
    await publish(now.id);
    expect((await detail(now.id)).statusCode).toBe('PUBLISHED');

    const later = await create('나중', { startDate: shift(7) });
    await publish(later.id);
    expect((await detail(later.id)).statusCode).toBe('SCHEDULED');
  });

  it('⛔ 게시한 공지는 본문을 고칠 수 없다 — 409', async () => {
    const { id } = await create('잠김');
    const etag = await publish(id);

    const rejected = await request(app.getHttpServer())
      .put(`/api/app/notices/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body('고쳐보기'))
      .expect(409);
    expect(rejected.body.conflictCause).toBe('user');
  });

  it('⭐ 게시 전에는 고칠 수 있다', async () => {
    const { id, etag } = await create('고칠것');
    const updated = await request(app.getHttpServer())
      .put(`/api/app/notices/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body('고친제목'))
      .expect(200);
    expect(updated.body.title).toBe(`${PREFIX} 고친제목`);
  });

  it('⭐ 종료는 지우는 것이 아니라 종료일을 오늘로 당기는 것이다', async () => {
    const { id } = await create('종료할것', { startDate: shift(-3) });
    const etag = await publish(id);

    const closed = await act(id, 'close', etag);
    expect(closed.body.endDate).toBe(today());
    // 행은 그대로다 — 확인 이력이 남아야 한다.
    expect(await prisma.notice.count({ where: { notice_id: id } })).toBe(1);

    // ⚠ 계약을 «글자대로» 따른 결과다 — 「종료일을 오늘로 당긴다」 + 「CLOSED = 종료일 <
    // 오늘」이라, 오늘 종료해도 오늘 하루는 PUBLISHED 다. 화면의 「종료됨」과 어긋나
    // 보이는 자리라 되돌림 §Y-7 로 설계팀에 물었다. 어제로 당기면 즉시 CLOSED 가 된다.
    expect(closed.body.statusCode).toBe('PUBLISHED');

    // 종료일이 지난 뒤에는 CLOSED 로 파생된다 — 표를 직접 밀어 그 하루 뒤를 흉내 낸다.
    await prisma.notice.update({
      where: { notice_id: id },
      data: { end_date: new Date(`${shift(-1)}T00:00:00.000Z`) },
    });
    expect((await detail(id)).statusCode).toBe('CLOSED');
  });

  it('⛔ 게시하지 않은 공지는 종료할 수 없다 — 409', async () => {
    const { id, etag } = await create('미게시종료');
    await request(app.getHttpServer())
      .post(`/api/app/notices/${id}:close`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(409);
  });

  it('⭐ 확인·닫음·미확인은 서로 다른 상태다', async () => {
    const { id } = await create('세상태', { acknowledgeRequired: false });
    await publish(id);

    await mark(id, 'acknowledge').expect(204);
    // 다른 사람은 「확인 없이 닫음」
    await request(app.getHttpServer())
      .post(`/api/app/notices/${id}:dismiss`)
      .set('Cookie', readerCookie)
      .set('Idempotency-Key', key())
      .expect(204);

    const rows = await prisma.notice_acknowledgement.findMany({ where: { notice_id: id } });
    const dismissed = rows.find((r) => r.app_user_id === otherUserId);
    expect(rows.find((r) => r.acknowledged)).toBeDefined();
    // ⭐ 닫음도 «시각이 찍힌» 행으로 남는다 — 행이 없는 것(미확인)과 다르다.
    expect(dismissed?.acknowledged).toBe(false);
    expect(dismissed?.acknowledged_at).not.toBeNull();
  });

  it('⛔ 확인이 필요한 공지는 닫을 수 없다 — 400', async () => {
    const { id } = await create('확인필수', { acknowledgeRequired: true });
    await publish(id);

    await request(app.getHttpServer())
      .post(`/api/app/notices/${id}:dismiss`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
  });

  it('⛔ 게시하지 않은 공지는 확인할 수 없다 — 409', async () => {
    const { id } = await create('미게시확인');
    await mark(id, 'acknowledge').expect(409);
  });

  it('⭐ 확인 현황이 «미확인자»까지 세운다 — 행이 없는 것이 미확인이다', async () => {
    const { id } = await create('현황', { acknowledgeRequired: true });
    await publish(id);
    await mark(id, 'acknowledge').expect(204);

    const all = await acknowledgements(id, '');
    const validate = validator('GET /app/notices/{noticeId}/acknowledgements');
    expect(validate(all)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 전사 공지라 쓰는 계정 전부가 분모다 — 확인 안 한 사람도 줄로 나온다.
    expect(all.items.length).toBeGreaterThan(1);
    expect(all.items.filter((r) => r.acknowledged)).toHaveLength(1);

    const pending = await acknowledgements(id, 'pendingOnly=true');
    expect(pending.items.every((r) => !r.acknowledged)).toBe(true);
    expect(pending.items.length).toBe(all.items.length - 1);
  });

  it('⭐ 확인 수와 대상 수가 함께 온다 — 전사는 분모가 있고 작업지시는 비운다', async () => {
    const { id } = await create('분모', { acknowledgeRequired: true });
    await publish(id);
    await mark(id, 'acknowledge').expect(204);

    const notice = await detail(id);
    expect(notice.acknowledgedCount).toBe(1);
    expect(notice.targetCount).toBeGreaterThan(0);
  });

  it('⭐ 목록이 계약 스키마를 만족하고 상태로 거른다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/app/notices?q=${encodeURIComponent(PREFIX)}&statusCode=DRAFT`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /app/notices');
    expect(validate(list.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(list.body.items.every((n: { statusCode: string }) => n.statusCode === 'DRAFT')).toBe(true);
  });

  it('⭐ 기간이 «겹치는» 것으로 거른다 — 시작일 기준이 아니다', async () => {
    const { id } = await create('겹침', { startDate: shift(-10), endDate: shift(10) });
    await publish(id);

    // 시작일보다 뒤인 구간이라 「시작일 기준」이면 안 걸리지만, 겹치므로 걸려야 한다.
    const overlapped = await request(app.getHttpServer())
      .get(`/api/app/notices?q=${encodeURIComponent(`${PREFIX} 겹침`)}&overlapFrom=${today()}&overlapTo=${shift(2)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(overlapped.body.items.map((n: { noticeId: number }) => n.noticeId)).toContain(id);
  });

  it('⭐ unacknowledgedByMe 는 아직 아무것도 안 한 게시 중 공지만 준다', async () => {
    const { id } = await create('안읽음', { startDate: shift(-1) });
    await publish(id);

    const before = await mine();
    expect(before).toContain(id);

    await mark(id, 'acknowledge').expect(204);
    expect(await mine()).not.toContain(id);
  });

  it('⛔ 없는 공지는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/notices/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function body(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: `${PREFIX} ${title}`,
      body: '검사용 본문',
      startDate: today(),
      scopeCode: 'COMPANY',
      ...extra,
    };
  }

  function post(payload: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/app/notices')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(payload);
  }

  async function create(
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await post(body(title, extra)).expect(201);
    const validate = validator('POST /app/notices', 201);
    expect(validate(created.body)).toBe(true);
    const id = created.body.noticeId as number;
    return { id, etag: await etagOf(id) };
  }

  async function etagOf(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/notices/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function detail(id: number): Promise<NoticeBody> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/notices/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /app/notices/{noticeId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  function act(id: number, action: string, etag: string): request.Test {
    return request(app.getHttpServer())
      .post(`/api/app/notices/${id}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
  }

  async function publish(id: number): Promise<string> {
    const response = await act(id, 'publish', await etagOf(id));
    return response.headers.etag;
  }

  function mark(id: number, action: 'acknowledge' | 'dismiss'): request.Test {
    return request(app.getHttpServer())
      .post(`/api/app/notices/${id}:${action}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key());
  }

  async function acknowledgements(
    id: number,
    query: string,
  ): Promise<{ items: { acknowledged: boolean }[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/notices/${id}/acknowledgements?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  async function mine(): Promise<number[]> {
    const response = await request(app.getHttpServer())
      .get(`/api/app/notices?unacknowledgedByMe=true&q=${encodeURIComponent(PREFIX)}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body.items.map((n: { noticeId: number }) => n.noticeId);
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const notices = await prisma.notice.findMany({
      where: { title: { startsWith: PREFIX } },
      select: { notice_id: true },
    });
    await prisma.notice_acknowledgement.deleteMany({
      where: { notice_id: { in: notices.map((n) => n.notice_id) } },
    });
    await prisma.notice.deleteMany({ where: { title: { startsWith: PREFIX } } });
    for (const id of [LOGIN_ID, READER_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.notice_acknowledgement.deleteMany({ where: { app_user_id: target.app_user_id } });
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
  }
});
