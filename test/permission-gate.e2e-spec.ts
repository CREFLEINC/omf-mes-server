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
import { Contract, ContractRegistry } from '../src/common/contract';
import { OPERATION_PERMISSIONS } from '../src/common/permissions';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * 계약이 403 을 선언했는데 권한이 아직 등록되지 않은 오퍼레이션을 «찾아» 쓴다.
 *
 * ⛔ 하드코딩하면 그 자리를 구현하는 PR 마다 이 검사가 깨진다 — 실제로 `GET /app/roles`
 * 로 적어 두었다가 역할 마스터가 서면서 깨졌다. 남은 후보가 0이 되면 게이트가 완성된
 * 것이므로, 그때는 던지는 대신 이 검사 자체를 지운다.
 */
function pickUnregistered(): { key: string; route: string } {
  const registry = ContractRegistry.load();
  const key = registry
    .keys()
    .filter((candidate) => candidate.startsWith('GET '))
    .sort()
    .find((candidate) => {
      const responses = (registry.get(candidate)?.operation as {
        responses?: Record<string, unknown>;
      }).responses;
      return (
        responses !== undefined && '403' in responses && !(candidate in OPERATION_PERMISSIONS)
      );
    });
  if (key === undefined) {
    throw new Error('권한 미등록 403 자리가 없다 — 게이트가 완성됐으므로 이 검사를 지운다');
  }
  // 실재 경로와 부딪히지 않게 접두어를 붙인다. 가드는 «메타데이터»만 보므로 경로가
  // 달라도 판정은 같다. 경로 파라미터는 이름을 그대로 살린다 — 계약 검증 가드가 본다.
  return { key, route: `gate-probe${key.slice(4).replace(/\{(\w+)\}/g, ':$1')}` };
}

const UNREGISTERED = pickUnregistered();

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

  /** 계약이 403 을 선언했으나 권한이 «도출되지 않은» 자리. 남은 것에서 골라 온다. */
  @Get(UNREGISTERED.route)
  @Contract(UNREGISTERED.key)
  unregistered(): unknown {
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
      data: { login_id: LOGIN_ID, user_name: '권한검사', status_code: 'ACTIVE' },
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

  it('⛔ 권한이 도출되지 않은 자리는 통과가 아니라 던짐이다 — F-6', async () => {
    // 500 이 난다. 사용자 문구가 아니라 «구현이 멈춰야 하는» 자리다.
    await request(app.getHttpServer())
      .get(`/api/${UNREGISTERED.route.replace(/:\w+/g, '1')}`)
      .set('Cookie', cookie)
      .expect(500);
  });

  it('⭐ 권한을 주면 지나간다', async () => {
    await grant('W-CO-11');

    await request(app.getHttpServer())
      .get('/api/app/notification-subscriptions')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('⭐ 여러 화면이 쓰는 경로는 그중 하나만 있으면 된다', async () => {
    // GET /app/approval-requests 는 W-03-09 · W-CO-09 둘이 쓴다.
    await grant('W-CO-09');
    const session = await request(app.getHttpServer())
      .get('/api/app/sessions/current')
      .set('Cookie', cookie)
      .expect(200);

    expect(session.body.permissions).toContain('W-CO-09');
    expect(session.body.permissions).not.toContain('W-03-09');
  });
});
