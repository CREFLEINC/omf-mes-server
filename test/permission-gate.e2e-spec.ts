/**
 * 권한 게이트는 «계약이 403 을 선언한 자리»에서만 돈다.
 * 선언하지 않은 곳에서 403 을 내면 계약과 어긋난다 — 실측: 선언 253 · 미선언 237.
 */
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { Contract } from '../src/common/contract';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * ⭐⭐ 2026-09-09 — 「권한이 «도출되지 않은» 자리」 탐침을 여기서 걷어냈다.
 *
 * 그 탐침은 계약에서 **403 을 선언했는데 미등록인** 오퍼레이션을 하나 찾아 붙여, 가드가
 * 통과가 아니라 **던짐**으로 가는지(F-6) 확인했다. 2026-09-05 에 「GET 중에 없을 뿐」이라
 * 메서드를 넓혔는데, 이번엔 **메서드를 통틀어 0** 이 됐다 — 게이트가 실제로 완성됐다.
 * (전건 250/250 등록 · `operation-permissions.spec.ts`)
 *
 * ⇒ 그 축은 **e2e 로 더는 만들 수 없다**. README §6-3 의 「e2e 로 반증 불가 부류」대로
 *   「반증 불가」를 결론이 아니라 **어느 층으로 내려갈지의 신호**로 읽고 둘로 갈랐다:
 *   - **던짐 자체**(F-6) → `src/common/permissions/permission.guard.spec.ts`(단위)
 *   - **미등록이 0 이라는 사실** → `operation-permissions.spec.ts` 의 전건 일치 단언
 *
 * ⛔ 여기에 탐침을 되살리지 마라 — 미등록 자리가 다시 생기면 그 두 spec 이 먼저 빨개진다.
 */
@Controller()
class GateProbeController {
  /** 계약이 403 을 선언하고 권한이 도출된 자리 — `W-CO-11` 하나만 요구한다. */
  @Get('app/notification-subscriptions')
  @Contract('GET /app/notification-subscriptions')
  gated(): unknown {
    return { items: [] };
  }

  /** 계약이 403 을 선언하지 «않은» 자리. */
  @Get('logistics/sales-orders')
  @Contract('GET /logistics/sales-orders')
  ungated(): unknown {
    return { items: [] };
  }
}

@Module({ imports: [AppModule], controllers: [GateProbeController] })
class ProbeModule {}

const LOGIN_ID = 'e2e-permgate-probe';
const PASSWORD = '권한게이트-검사-비밀번호';

describe('권한 게이트 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: bigint;
  let cookie: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), ProbeModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '권한검사', status_code: 'EMPLOYED' },
    });
    userId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: userId, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const existing = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (existing) {
      await prisma.user_role.deleteMany({ where: { app_user_id: existing.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: existing.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: existing.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: 'E2E_PERMGATE' } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }

  async function grant(permission: string): Promise<void> {
    const role = await prisma.role.upsert({
      where: { role_code: 'E2E_PERMGATE' },
      update: { is_active: true },
      create: { role_code: 'E2E_PERMGATE', role_name: '권한검사용', is_active: true },
    });
    await prisma.role_permission.upsert({
      where: { role_id_permission_code: { role_id: role.role_id, permission_code: permission } },
      update: {},
      create: { role_id: role.role_id, permission_code: permission },
    });
    await prisma.user_role.upsert({
      where: { app_user_id_role_id: { app_user_id: userId, role_id: role.role_id } },
      update: {},
      create: { app_user_id: userId, role_id: role.role_id },
    });
    cookie = await login();
  }

  it('⛔ 권한이 없으면 403 이다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/notification-subscriptions')
      .set('Cookie', cookie)
      .expect(403);

    expect(response.body.errors[0]).toMatchObject({
      scope: 'screen',
      code: 'PERMISSION_DENIED',
    });
  });

  it('⭐ 계약이 403 을 선언하지 않은 자리는 권한을 보지 않는다', async () => {
    // 안 그러면 「지금 나는 누구인가」 같은 자리가 잠긴다 — 계약이 그 구분을 이미 했다.
    await request(app.getHttpServer())
      .get('/api/logistics/sales-orders')
      .set('Cookie', cookie)
      .expect(200);
  });


  it('⭐ 권한을 주면 지나간다', async () => {
    await grant('W-CO-11');

    await request(app.getHttpServer())
      .get('/api/app/notification-subscriptions')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('⭐ 여러 화면이 쓰는 경로는 그중 하나만 있으면 된다', async () => {
    // GET /app/approval-requests 는 다섯이 쓴다 — 도출 W-01-13·W-03-09·W-CO-09 +
    // 수동 M-01-13·W-01-02(통보 189). 그중 하나만 있으면 된다.
    await grant('W-CO-09');
    const session = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', cookie)
      .expect(200);

    expect(session.body.permissions).toContain('W-CO-09');
    expect(session.body.permissions).not.toContain('W-03-09');
  });
});
