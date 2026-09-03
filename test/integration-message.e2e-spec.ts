/**
 * 연계 메시지.
 *
 * ⭐ 이 화면의 본질은 「비동기 워커의 상태를 사람이 읽고 «개입»하는 창」이다(계약).
 * 그래서 재처리의 두 거절 사유(워커가 잡고 있음 · 실패가 아님)를 가르는 것이 본체다.
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
import { MESSAGE_STATUS } from '../src/integration/message/integration-message.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-ifmsg-probe';
const NOPERM_ID = 'e2e-ifmsg-noperm';
const PASSWORD = '연계메시지-검사-비밀번호';
const PREFIX = 'E2E_IFMSG';
const ROLE = 'E2E_IFMSG_ROLE';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2030-01-01T00:00:00.000Z';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('연계 메시지 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '메시지검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '메시지검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-10' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 기간이 없으면 400 이다 — 「기간 미지정 조회는 제공하지 않는다」', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/integration/messages')
      .set('Cookie', cookie)
      .expect(400);

    expect(rejected.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'createdFrom',
      'createdTo',
    ]);
  });

  it('목록이 계약 스키마를 만족하고 payload 를 «싣지 않는다»', async () => {
    await seed({ statusCode: MESSAGE_STATUS.FAILED });

    const response = await request(app.getHttpServer())
      .get(`/api/integration/messages?createdFrom=${FROM}&createdTo=${TO}&interfaceCode=${PREFIX}_IF`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /integration/messages');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // ⛔ 대외비를 담을 수 있어 목록이 전 행의 payload 를 나르지 않는다(계약).
    expect(response.body.items[0]).not.toHaveProperty('payload');
  });

  it('⭐ 상세만 payload 를 낸다', async () => {
    const id = await seed({ statusCode: MESSAGE_STATUS.FAILED, payload: { poNo: 'PO-1', qty: 10 } });

    const response = await request(app.getHttpServer())
      .get(`/api/integration/messages/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /integration/messages/{integrationMessageId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.payload).toEqual({ poNo: 'PO-1', qty: 10 });
  });

  it('⭐ 실패한 메시지를 재처리하면 대기로 돌아가고 시각이 지금으로 당겨진다', async () => {
    const later = new Date(Date.now() + 3600_000);
    const id = await seed({ statusCode: MESSAGE_STATUS.FAILED, availableAt: later });

    const response = await request(app.getHttpServer())
      .post(`/api/integration/messages/${id}:retry`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    const validate = validator('POST /integration/messages/{integrationMessageId}:retry');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(response.body.statusCode).toBe(MESSAGE_STATUS.PENDING);
    // 백오프가 미뤄 둔 시각을 사람이 앞당기는 것이 이 액션의 뜻이다.
    expect(new Date(response.body.availableAt).getTime()).toBeLessThan(later.getTime());
    // ⛔ 시도 횟수는 워커가 올린다 — 서버가 손대지 않는다.
    expect(response.body.retryCount).toBe(0);
  });

  it('⭐⭐ 워커가 잡고 있으면 409 workerLease 다 — 낙관적 잠금이 아니라 리스 충돌', async () => {
    const id = await seed({ statusCode: MESSAGE_STATUS.FAILED, lockedBy: 'worker-1' });

    const rejected = await request(app.getHttpServer())
      .post(`/api/integration/messages/${id}:retry`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(409);

    // ⛔ 이 표에 version_no 가 없다 — 그래서 user 가 아니라 workerLease 다.
    expect(rejected.body).toEqual({
      conflictCause: 'workerLease',
      message: expect.stringContaining('워커'),
    });
  });

  it('⛔ 실패가 아니면 400 NOT_RETRYABLE 이다', async () => {
    for (const statusCode of [MESSAGE_STATUS.PENDING, MESSAGE_STATUS.COMPLETED]) {
      const id = await seed({ statusCode });
      const rejected = await request(app.getHttpServer())
        .post(`/api/integration/messages/${id}:retry`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('NOT_RETRYABLE');
    }
  });

  it('⭐⭐ 일괄은 부분 실패를 허용한다 — 전체를 되돌리지 않는다', async () => {
    const ok = await seed({ statusCode: MESSAGE_STATUS.FAILED });
    const locked = await seed({ statusCode: MESSAGE_STATUS.FAILED, lockedBy: 'worker-2' });
    const done = await seed({ statusCode: MESSAGE_STATUS.COMPLETED });

    const response = await request(app.getHttpServer())
      .post('/api/integration/messages:retry-batch')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ integrationMessageIds: [ok, locked, done, 999999999] })
      .expect(200);
    const validate = validator('POST /integration/messages:retry-batch');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // ⛔ 통과한 건은 «반영된 채로» 남는다 — 거부 건만 되돌린다(공유계약 C-2).
    expect(response.body.succeeded).toBe(1);
    expect(response.body.failed).toHaveLength(3);
    expect(response.body.failed.map((f: { index: number }) => f.index)).toEqual([1, 2, 3]);

    const after = await request(app.getHttpServer())
      .get(`/api/integration/messages/${ok}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.statusCode).toBe(MESSAGE_STATUS.PENDING);

    const untouched = await request(app.getHttpServer())
      .get(`/api/integration/messages/${locked}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(untouched.body.statusCode).toBe(MESSAGE_STATUS.FAILED);
  });

  it('⭐ 필터가 각각 듣는다 — 반복 실패를 찾는 주 경로가 retryCountMin 이다', async () => {
    await seed({ statusCode: MESSAGE_STATUS.FAILED, retryCount: 5, directionCode: 'OUTBOUND' });

    const repeated = await request(app.getHttpServer())
      .get(
        `/api/integration/messages?createdFrom=${FROM}&createdTo=${TO}&interfaceCode=${PREFIX}_IF&retryCountMin=3`,
      )
      .set('Cookie', cookie)
      .expect(200);
    expect(repeated.body.items).toHaveLength(1);
    expect(repeated.body.items[0].retryCount).toBe(5);

    const outbound = await request(app.getHttpServer())
      .get(
        `/api/integration/messages?createdFrom=${FROM}&createdTo=${TO}&interfaceCode=${PREFIX}_IF&directionCode=OUTBOUND`,
      )
      .set('Cookie', cookie)
      .expect(200);
    expect(outbound.body.items).toHaveLength(1);

    // 기간 밖은 안 걸린다.
    const outside = await request(app.getHttpServer())
      .get(
        `/api/integration/messages?createdFrom=2020-01-01T00:00:00.000Z&createdTo=2020-12-31T00:00:00.000Z&interfaceCode=${PREFIX}_IF`,
      )
      .set('Cookie', cookie)
      .expect(200);
    expect(outside.body.items).toEqual([]);
  });

  it('⛔ 권한이 없으면 403 이고, 없는 메시지는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`/api/integration/messages?createdFrom=${FROM}&createdTo=${TO}`)
      .set('Cookie', noPermCookie)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/integration/messages/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/integration/messages/999999999:retry')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function seed(row: {
    statusCode: string;
    payload?: object;
    availableAt?: Date;
    lockedBy?: string;
    retryCount?: number;
    directionCode?: string;
  }): Promise<number> {
    counter += 1;
    const created = await prisma.integration_message.create({
      data: {
        message_key: `${PREFIX}-${counter}`,
        interface_code: `${PREFIX}_IF`,
        direction_code: row.directionCode ?? 'INBOUND',
        target_type_code: 'ITEM',
        target_id: 1,
        payload: (row.payload ?? {}) as object,
        status_code: row.statusCode,
        retry_count: row.retryCount ?? 0,
        available_at: row.availableAt ?? new Date(),
        ...(row.lockedBy === undefined
          ? {}
          : { locked_by: row.lockedBy, locked_at: new Date() }),
      },
    });
    return Number(created.integration_message_id);
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
    counter = 0;
    await prisma.integration_message.deleteMany({
      where: { message_key: { startsWith: PREFIX } },
    });
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
