/**
 * 내 비밀번호 변경 — 화면 `W-CO-10`.
 *
 * ⭐ 계약이 로그인과 «다르게» 정한 두 가지가 이 스위트의 핵심이다 — 틀려도 잠그지 않고,
 * 바꾼 뒤 다시 로그인시키지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MAX_FAILED_ATTEMPTS } from '../src/auth/credential.service';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-pwd-probe';
const FIRST = '처음-비밀번호-1234';
const SECOND = '바꾼-비밀번호-5678';

describe('내 비밀번호 변경 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '비번검사', status_code: 'EMPLOYED' },
    });
    userId = user.app_user_id;
    await prisma.user_credential.create({
      data: {
        app_user_id: user.app_user_id,
        password_hash: await hashPassword(FIRST),
        // 임시 비밀번호로 받은 사람 — 이 검사가 강제 변경이 풀리는지 본다.
        must_change_password: true,
      },
    });
    cookie = await login(FIRST);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 짧은 비밀번호는 400 이다 — 계약이 최소 8자를 정했다', async () => {
    await change(FIRST, '짧다').expect(400);
  });

  it('⛔ 현재 비밀번호가 틀리면 401 이다 — 400 과 갈린다', async () => {
    const rejected = await change('아닌-비밀번호', SECOND).expect(401);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'currentPassword',
      code: 'INVALID',
    });
  });

  it('⛔ 틀려도 계정을 잠그지 않는다 — 이미 인증된 본인이다', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i += 1) {
      await change('계속-틀린-비밀번호', SECOND).expect(401);
    }

    const credential = await prisma.user_credential.findUniqueOrThrow({
      where: { app_user_id: userId },
    });
    expect(credential.failed_attempt_count).toBe(0);
    expect(credential.locked_until).toBeNull();
    // 잠기지 않았으니 원래 비밀번호로 여전히 로그인된다.
    await login(FIRST);
  });

  it('⭐ 바꾸면 204 이고, 강제 변경이 풀리며, 바꾼 쪽 세션은 그대로다', async () => {
    // 같은 계정의 «다른 기기» 로그인 — 변경 뒤 끊겨야 한다.
    const otherDevice = await login(FIRST);
    // 발급 시각은 초 단위라 같은 초 안의 변경은 가르지 못한다 — 초를 넘긴 뒤 바꾼다.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const before = await prisma.user_credential.findUniqueOrThrow({
      where: { app_user_id: userId },
    });
    expect(before.must_change_password).toBe(true);

    const changed = await change(FIRST, SECOND).expect(204);

    const after = await prisma.user_credential.findUniqueOrThrow({
      where: { app_user_id: userId },
    });
    expect(after.must_change_password).toBe(false);
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_changed_at.getTime()).toBeGreaterThan(before.password_changed_at.getTime());

    // ⛔ 다시 로그인시키지 않는다(계약 §5-3) — 변경 응답이 새 쿠키를 주고 그것이 통한다.
    cookie = setCookieOf(changed);
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', cookie)
      .expect(200);
    // 변경 전에 발급된 다른 기기의 쿠키는 끊긴다.
    await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', otherDevice)
      .expect(401);
  });

  it('⭐ 새 비밀번호로 로그인되고 옛 비밀번호는 막힌다', async () => {
    await login(SECOND);
    await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: FIRST })
      .expect(401);
  });

  it('⛔ 로그인하지 않으면 401 이다 — 「내」가 없다', async () => {
    await request(app.getHttpServer())
      .post('/api/app/users/me:change-password')
      .set('Idempotency-Key', randomUUID())
      .send({ currentPassword: SECOND, newPassword: '또-다른-비밀번호' })
      .expect(401);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function change(currentPassword: string, newPassword: string): request.Test {
    return request(app.getHttpServer())
      .post('/api/app/users/me:change-password')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ currentPassword, newPassword });
  }

  async function login(password: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password })
      .expect(200);
    return setCookieOf(response);
  }

  function setCookieOf(response: request.Response): string[] {
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!target) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
    await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
  }
});
