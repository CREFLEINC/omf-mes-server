/**
 * Zalo 연결 설정(W-CO-12 · omf-all-around#160 · 장부 P-95).
 *
 * ⛔ 비밀값 원문은 응답·DB·감사 어디에도 남지 않는다(FR-027~028 · SC-008).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { SecretBox } from '../src/core/crypto/secret-box';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `ZCON${randomUUID().slice(0, 6)}`;
const PATH = '/api/app/zalo-connection';
const SECRET = 'zalo-secret-원문-ABC123';
const REFRESH = 'refresh-token-원문-XYZ789';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
const validate: ValidateFunction = ajv.compile({
  $ref: 'https://omf-mes.invalid/contract#/paths/~1app~1zalo-connection/get/responses/200/content/application~1json/schema',
});

describe('Zalo 연결 설정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  const userIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await resetConnection();

    const jwt = app.get(JwtService);
    const admin = await makeUser('ADMIN', ['W-CO-12']);
    const denied = await makeUser('DENIED', ['W-CO-11']);
    cookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(admin), typ: 'session' })}`;
    deniedCookie = `${SESSION_COOKIE}=${jwt.sign({ sub: Number(denied), typ: 'session' })}`;
  });

  afterAll(async () => {
    await resetConnection();
    await prisma.audit_event.deleteMany({ where: { target_type_code: 'ZALO_CONNECTION', performed_by: { in: userIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await app.close();
  });

  it('US7-1 미설정이면 NOT_CONFIGURED·이벤트 6종 템플릿 null·ETag "1" 이고 행을 만들지 않는다', async () => {
    const response = await get();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.headers.etag).toBe('1');
    expect(response.body).toMatchObject({
      appId: null, secretKeySet: false, refreshTokenSet: false, status: 'NOT_CONFIGURED', paramMaxLength: 100, deliveryEnabled: false,
    });
    expect(response.body.templates).toHaveLength(6);
    expect(response.body.templates.every((t: { templateId: string | null }) => t.templateId === null)).toBe(true);
    expect(await prisma.zalo_connection.count()).toBe(0);
  });

  it('US7-1 FR-027 SC-008 세 값을 저장하면 ACTIVE, 응답엔 …Set 만, DB 는 암호문이고 원문과 다르다', async () => {
    const saved = await put('1', {
      appId: 'APP-1', secretKey: SECRET, refreshToken: REFRESH, paramMaxLength: 80,
      templates: [{ eventCode: 'WORK_SESSION_STARTED', templateId: 'TPL-START' }],
    }).expect(200);

    expect(saved.headers.etag).toBe('2');
    expect(saved.body).toMatchObject({ appId: 'APP-1', secretKeySet: true, refreshTokenSet: true, status: 'ACTIVE', paramMaxLength: 80 });
    expect(saved.body.templates.find((t: { eventCode: string }) => t.eventCode === 'WORK_SESSION_STARTED').templateId).toBe('TPL-START');
    expect(JSON.stringify(saved.body)).not.toMatch(/원문|ABC123|XYZ789/);
    expect(saved.body).not.toHaveProperty('secretKey');
    expect(saved.body).not.toHaveProperty('refreshToken');

    const row = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(row.secret_key_enc).not.toContain(SECRET);
    expect(row.refresh_token_enc).not.toContain(REFRESH);
    const box = new SecretBox(process.env.ZALO_CREDENTIAL_KEY as string);
    expect(box.open(row.secret_key_enc as string)).toBe(SECRET);
    expect(box.open(row.refresh_token_enc as string)).toBe(REFRESH);

    const audit = await prisma.audit_event.findFirstOrThrow({
      where: { target_type_code: 'ZALO_CONNECTION' }, orderBy: { occurred_at: 'desc' },
    });
    expect(audit.after_value).toEqual({ changedFields: ['appId', 'secretKey', 'refreshToken', 'paramMaxLength', 'templates'] });
    expect(text(audit)).not.toMatch(/ABC123|XYZ789/);
    expect(text(await prisma.idempotency_record.findMany({ where: { app_user_id: { in: userIds } } }))).not.toMatch(/ABC123|XYZ789/);
  });

  it('US7-1 비밀값을 생략하면 유지, 갱신 토큰을 바꾸면 접속 토큰을 비우고 ACTIVE 로 돌아간다', async () => {
    await prisma.zalo_connection.update({
      where: { zalo_connection_id: 1 },
      data: { status_code: 'REAUTH_REQUIRED', access_token_enc: 'v1:x:y:z', access_token_expires_at: new Date(), last_error_code: '-118' },
    });
    const etag = (await get()).headers.etag as string;

    // 템플릿만 고쳐서는 재인증 필요가 풀리지 않는다.
    const kept = await put(etag, { appId: 'APP-1', paramMaxLength: 80, templates: [{ eventCode: 'WORK_SESSION_STARTED', templateId: null }] }).expect(200);
    expect(kept.body).toMatchObject({ secretKeySet: true, refreshTokenSet: true, status: 'REAUTH_REQUIRED' });
    expect(kept.body.templates.every((t: { templateId: string | null }) => t.templateId === null)).toBe(true);

    const renewed = await put(kept.headers.etag as string, { appId: 'APP-1', refreshToken: 'new-refresh', paramMaxLength: 80, templates: [] }).expect(200);
    expect(renewed.body).toMatchObject({ status: 'ACTIVE', accessTokenExpiresAt: null, lastErrorCode: null });
    const row = await prisma.zalo_connection.findUniqueOrThrow({ where: { zalo_connection_id: 1 } });
    expect(row.access_token_enc).toBeNull();
  });

  it('US7-1 appId 를 비우면 NOT_CONFIGURED 다', async () => {
    const etag = (await get()).headers.etag as string;
    const saved = await put(etag, { appId: null, paramMaxLength: 80, templates: [] }).expect(200);
    expect(saved.body.status).toBe('NOT_CONFIGURED');
  });

  it.each([
    ['빈 비밀 키', { secretKey: '' }, 'secretKey'],
    ['공백 갱신 토큰', { refreshToken: '   ' }, 'refreshToken'],
    ['paramMaxLength 19', { paramMaxLength: 19 }, 'paramMaxLength'],
    ['paramMaxLength 401', { paramMaxLength: 401 }, 'paramMaxLength'],
    ['모르는 eventCode', { templates: [{ eventCode: 'MOLD_RECOMMENDED_SHOTS_EXCEEDED', templateId: 'X' }] }, 'templates'],
  ])('%s 는 400 이다', async (_label, extra, fieldName) => {
    const etag = (await get()).headers.etag as string;
    const response = await put(etag, { appId: 'APP-1', paramMaxLength: 80, templates: [], ...extra }).expect(400);
    expect(JSON.stringify(response.body.errors)).toContain(fieldName);
  });

  it('If-Match 불일치는 409, W-CO-12 권한이 없으면 403 이다', async () => {
    await put('999', { appId: 'APP-1', paramMaxLength: 80, templates: [] }).expect(409);
    await request(app.getHttpServer()).get(PATH).set('Cookie', deniedCookie).expect(403);
    await request(app.getHttpServer())
      .put(PATH)
      .set('Cookie', deniedCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ appId: null, paramMaxLength: 100, templates: [] })
      .expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function text(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  }

  function get(): Promise<request.Response> {
    return request(app.getHttpServer()).get(PATH).set('Cookie', cookie).expect(200);
  }

  function put(ifMatch: string, body: object): request.Test {
    return request(app.getHttpServer())
      .put(PATH)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', ifMatch)
      .send(body);
  }

  /** 연결은 시스템 1행이라 시험 전후로 비운다 — 다른 e2e 가 «미설정»을 전제한다. */
  async function resetConnection(): Promise<void> {
    await prisma.zalo_template.deleteMany();
    await prisma.zalo_connection.deleteMany();
  }

  async function makeUser(key: string, permissions: string[]): Promise<bigint> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${key}`, user_name: key, status_code: 'EMPLOYED' } });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${key}`, role_name: `Zalo 연결 ${key}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return user.app_user_id;
  }
});
