import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-login-user';
const PASSWORD = 'e2e-correct-password';

describe('POST /api/auth/login (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'e2e 사용자', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await app.get(PasswordService).hash(PASSWORD),
        must_change_password: true,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const existing = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!existing) return;
    await prisma.user_credential.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: existing.app_user_id } });
  }

  function login(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/api/auth/login').send(body);
  }

  async function resetFailureCount(): Promise<void> {
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    await prisma.user_credential.update({
      where: { app_user_id: user.app_user_id },
      data: { failed_attempt_count: 0 },
    });
  }

  it('올바른 자격증명이면 검증 가능한 토큰을 준다', async () => {
    const { body } = await login({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);

    expect(body).toMatchObject({ expiresIn: 28800, mustChangePassword: true });

    const payload = await jwt.verifyAsync<{ loginId: string; sub: string }>(body.accessToken);
    expect(payload.loginId).toBe(LOGIN_ID);
    expect(payload.sub).toMatch(/^\d+$/);
  });

  it('시드가 만든 admin 의 해시 형식을 읽는다', async () => {
    // 시드와 해시 형식이 어긋나면 배포 직후 아무도 로그인할 수 없다.
    const admin = await prisma.app_user.findUnique({
      where: { login_id: 'admin' },
      include: { user_credential: true },
    });

    expect(admin?.user_credential?.password_hash).toMatch(/^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
  });

  it('틀린 비밀번호는 401 이고 사유를 밝히지 않는다', async () => {
    const { body } = await login({ loginId: LOGIN_ID, password: '틀린 비밀번호' }).expect(401);

    expect(body.message).toBe('로그인할 수 없습니다.');
  });

  it('없는 계정도 틀린 비밀번호와 똑같이 답한다 — 계정 열거를 막는다', async () => {
    const { body } = await login({ loginId: '없는-계정', password: PASSWORD }).expect(401);

    expect(body.message).toBe('로그인할 수 없습니다.');
  });

  it('실패하면 카운터가 오르고 성공하면 0 으로 돌아간다', async () => {
    // 앞선 테스트가 남긴 실패 횟수에 기대지 않는다 — 실행 순서에 의존하면 안 된다.
    await resetFailureCount();

    await login({ loginId: LOGIN_ID, password: '틀림' }).expect(401);
    await login({ loginId: LOGIN_ID, password: '틀림' }).expect(401);

    const afterFailures = await prisma.app_user.findUniqueOrThrow({
      where: { login_id: LOGIN_ID },
      include: { user_credential: true },
    });
    expect(afterFailures.user_credential?.failed_attempt_count).toBe(2);

    await login({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);

    const afterSuccess = await prisma.app_user.findUniqueOrThrow({
      where: { login_id: LOGIN_ID },
      include: { user_credential: true },
    });
    expect(afterSuccess.user_credential?.failed_attempt_count).toBe(0);
    expect(afterSuccess.user_credential?.last_login_at).not.toBeNull();
  });

  it('5회 실패해도 잠기지 않는다 — 잠금은 결정으로 보류했다', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login({ loginId: LOGIN_ID, password: '틀림' }).expect(401);
    }

    await login({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);
  });

  it.each([
    ['loginId 누락', { password: PASSWORD }],
    ['password 누락', { loginId: LOGIN_ID }],
    ['정의되지 않은 필드', { loginId: LOGIN_ID, password: PASSWORD, extra: 'x' }],
  ])('%s 는 400 이다', async (_label, body) => {
    await login(body).expect(400);
  });
});
