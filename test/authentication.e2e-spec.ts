/**
 * 인증 가드가 계약에 묶인 자리를 지키는지, 그리고 «순서»가 맞는지 본다.
 * 순서가 뒤집히면 미인증 호출자가 401 대신 400 과 함께 계약 스키마의 생김새를 받는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-authguard-probe';
const PASSWORD = '인증가드-검사-비밀번호';

describe('인증 가드 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '인증검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = login.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
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

  it('⭐ 로그인은 면제다 — 권한은 세션에서 나오고 세션은 로그인이 만든다', async () => {
    await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
  });

  it('⛔ 세션 없이 계약에 묶인 자리를 부르면 401 이다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .expect(401);

    expect(response.body.errors[0]).toMatchObject({
      scope: 'screen',
      code: 'PERMISSION_DENIED',
    });
  });

  it('세션이 있으면 지나간다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('⛔ 망가진 쿠키는 401 이다 — 만료·위조를 가리지 않는다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', 'omf_session=not-a-valid-jwt')
      .expect(401);
  });

  it('⭐ 인증이 계약 검증보다 «먼저» 돈다 — 미인증에 본문이 틀려도 401 이다', async () => {
    // 순서가 뒤집히면 400 과 함께 어느 칸이 필수인지가 새어 나간다.
    const response = await request(app.getHttpServer())
      .delete('/api/app/sessions/current')
      .expect(401);

    expect(response.body.errors[0].code).toBe('PERMISSION_DENIED');
  });

  it('⭐ 인증이 멱등 검사보다 «먼저» 돈다 — 미인증이면 키가 없어도 401 이다', async () => {
    // DELETE /app/sessions/current 는 계약이 Idempotency-Key 를 요구하는 자리다.
    const response = await request(app.getHttpServer())
      .delete('/api/app/sessions/current')
      .expect(401);

    expect(response.body.errors[0].code).not.toBe('REQUIRED');
  });

  it('계약에 묶이지 않은 자리는 인증을 요구하지 않는다 — 헬스체크', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });
});
