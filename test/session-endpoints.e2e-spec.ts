import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

function contractValidator(schema: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
  ) as { components: Record<string, unknown> };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'contract', components: contract.components });
  return ajv.compile({ $ref: `contract#/components/schemas/${schema}` });
}

describe('세션 엔드포인트 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const LOGIN_ID = 'e2e-session-probe';
  const PASSWORD = '세션-검사-비밀번호';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();

    prisma = app.get(PrismaService);
    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '세션검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const existing = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!existing) return;
    await prisma.user_role.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: existing.app_user_id } });
  }

  async function reset(): Promise<void> {
    await prisma.user_credential.updateMany({
      where: { app_user: { login_id: LOGIN_ID } },
      data: { failed_attempt_count: 0, locked_until: null },
    });
  }

  beforeEach(reset);

  it('⭐ 로그인이 200 과 계약 Session 을 주고 httpOnly 쿠키를 세운다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);

    expect(contractValidator('Session')(response.body)).toBe(true);
    expect(response.body).toMatchObject({ loginId: LOGIN_ID, userName: '세션검사' });

    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('⛔ 틀린 비밀번호는 401 과 계약 LoginFailure 다 — ErrorResponse 봉투가 아니다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: '틀린값' })
      .expect(401);

    expect(contractValidator('LoginFailure')(response.body)).toBe(true);
    expect(response.body.remainingAttempts).toBe(4);
    // 봉투가 씌워지지 않는다 — 계약은 이 401 을 LoginFailure 로 정의했다.
    expect(response.body).not.toHaveProperty('errors');
  });

  it('⛔ 「무엇이 틀렸는지」가 응답으로 갈리지 않는다 — 있는 계정과 없는 계정의 문구가 같다', async () => {
    // 계약: 「아이디와 비밀번호 중 무엇이 틀렸는지 말하지 않는다 — 계정이 있는지가 새어 나간다」.
    // 문구를 글자로 검사하면 표현만 보게 되므로, 두 경우의 응답이 «같은가»를 본다.
    const wrongPassword = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: '틀린값' })
      .expect(401);
    const noSuchAccount = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: '없는-계정', password: '틀린값' })
      .expect(401);

    expect(wrongPassword.body.message).toBe(noSuchAccount.body.message);
  });

  it('⛔ 없는 계정에는 remainingAttempts 가 오지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: '없는-계정', password: '아무거나' })
      .expect(401);

    expect(response.body).not.toHaveProperty('remainingAttempts');
  });

  it('⭐ 계약 검증 가드가 로그인 본문을 거른다 — loginId 누락은 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ password: 'x' })
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'loginId' });
  });

  it('잠기면 423 을 낸다', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/app/sessions')
        .send({ loginId: LOGIN_ID, password: '틀린값' });
    }

    await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(423);
  });

  it('쿠키로 현재 세션을 읽는다', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', login.headers['set-cookie'])
      .expect(200);

    expect(response.body).toMatchObject({ loginId: LOGIN_ID });
  });

  it('쿠키가 없으면 401 이다 — ⚠ 계약이 이 경로에 200 만 선언했다(설계팀 확인 대상)', async () => {
    await request(app.getHttpServer()).get('/api/app/sessions/current').expect(401);
  });

  it('망가진 쿠키도 401 이다 — 만료·위조를 가리지 않는다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      // HTTP 헤더는 ASCII 다 — 한글을 넣으면 요청 자체가 안 나간다.
      .set('Cookie', `${SESSION_COOKIE}=not-a-valid-jwt`)
      .expect(401);
  });

  it('⭐ 로그아웃이 204 를 내고 쿠키를 지운 뒤에는 세션이 서지 않는다', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);

    const logout = await request(app.getHttpServer())
      .delete('/api/app/sessions/current')
      .set('Cookie', login.headers['set-cookie'])
      .expect(204);

    expect(logout.headers['set-cookie'][0]).toContain(`${SESSION_COOKIE}=;`);

    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', logout.headers['set-cookie'])
      .expect(401);
  });

  it('⛔ JWT_SECRET 이 약하면 부팅에서 죽는다 — 기본값을 되살리면 세션을 위조할 수 있다', async () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'too-short';

    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
      /JWT_SECRET/,
    );

    process.env.JWT_SECRET = saved;
  });
});
