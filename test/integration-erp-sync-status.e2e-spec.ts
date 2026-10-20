/**
 * ERP 받기 표별 상태 `GET /integration/erp-sync/tables`·「지금 읽기」 `POST …/{interfaceCode}:run`(장부 P-81).
 * 계약 사본에 없는 경로라 인증·권한을 컨트롤러가 직접 한다 — 401·403 도 여기서 본다.
 *
 * ⚠ 이 시험 서버는 ERP 연동이 꺼져 있다(실행기가 돌지 않는다). 「켜진 서버」 갈래는 요청 시점의
 * `ConfigService` 만 켠 것으로 바꿔 본다 — 실행기는 부팅 때 꺼진 채로 만들어져 요청을 집어 가지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { SyncState } from '../src/integration/erp/sync-state';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-ERPSYNC';
const PATH = '/api/integration/erp-sync/tables';
const CODE = 'IF-ERP-SO-RECV';
const CODES = [
  'IF-ERP-CODE-RECV',
  'IF-ERP-EMP-RECV',
  'IF-ERP-ITEM-RECV',
  'IF-ERP-BP-RECV',
  'IF-ERP-BOM-RECV',
  'IF-ERP-PO-RECV',
  'IF-ERP-SO-RECV',
  'IF-ERP-PRODORD-RECV',
];

describe('ERP 받기 표별 상태·지금 읽기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<string, string> = {};
  const users: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    // 운영자 W-06-10 · 품질 쪽 W-02-06(상태만 본다) · 권한 없음.
    for (const [name, permission] of [
      ['operator', 'W-06-10'],
      ['viewer', 'W-02-06'],
      ['none', undefined],
    ] as const) {
      const user = await prisma.app_user.create({
        data: { login_id: `${PREFIX}-${name}`, user_name: PREFIX, status_code: 'EMPLOYED' },
      });
      users[name] = user.app_user_id;
      if (permission !== undefined) {
        const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${name}`, role_name: PREFIX } });
        await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
        await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      }
      cookies[name] = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const enable = (): void => {
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(((name: string) => (name === 'ERP_SYNC_ENABLED' ? 'true' : original(name))) as never);
  };

  it('⛔ 로그인이 없으면 둘 다 401 이다 — 가드 밖 경로라 컨트롤러가 직접 막는다', async () => {
    await request(app.getHttpServer()).get(PATH).expect(401);
    await request(app.getHttpServer()).post(`${PATH}/${CODE}:run`).expect(401);
  });

  it('⛔ 연계 메시지를 볼 권한이 없으면 상태도 403 · W-06-10 이 아니면 지금 읽기는 403', async () => {
    const denied = await request(app.getHttpServer()).get(PATH).set('Cookie', cookies.none).expect(403);
    expect(denied.body.errors[0]).toMatchObject({ scope: 'screen', code: 'PERMISSION_DENIED' });
    await request(app.getHttpServer()).get(PATH).set('Cookie', cookies.viewer).expect(200);
    await request(app.getHttpServer()).post(`${PATH}/${CODE}:run`).set('Cookie', cookies.viewer).expect(403);
  });

  it('⭐ 여덟 표를 묶음 순서(기준정보 → 전표)로 낸다 — 꺼진 서버는 enabled=false', async () => {
    const response = await request(app.getHttpServer()).get(PATH).set('Cookie', cookies.operator).expect(200);
    expect(response.body.enabled).toBe(false);
    expect(response.body.items.map((i: { interfaceCode: string }) => i.interfaceCode)).toEqual(CODES);
    expect(response.body.items[0]).toMatchObject({ name: '공통코드', laneCode: 'MASTER', laneName: '기준정보' });
    expect(response.body.items[7]).toMatchObject({ name: 'ERP W/O', laneCode: 'ORDER', laneName: '전표' });
  });

  it('⛔ 꺼진 서버에서 지금 읽기는 400 STATE_LOCKED 다 — 집어 갈 실행기가 없다', async () => {
    const response = await request(app.getHttpServer()).post(`${PATH}/${CODE}:run`).set('Cookie', cookies.operator).expect(400);
    expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    expect(await prisma.erp_sync_state.findUnique({ where: { interface_code: CODE } })).toBeNull();
  });

  it('없는 표는 404 다', async () => {
    enable();
    await request(app.getHttpServer()).post(`${PATH}/IF-NOPE:run`).set('Cookie', cookies.operator).expect(404);
  });

  it('⭐ 켜진 서버에서는 202 로 요청을 적어 두고, 다시 눌러도 처음 시각을 지킨다', async () => {
    enable();
    const first = await request(app.getHttpServer()).post(`${PATH}/${CODE}:run`).set('Cookie', cookies.operator).expect(202);
    expect(first.body).toEqual({ interfaceCode: CODE, requestedAt: expect.any(String) });
    const second = await request(app.getHttpServer()).post(`${PATH}/${CODE}:run`).set('Cookie', cookies.operator).expect(202);
    expect(second.body.requestedAt).toBe(first.body.requestedAt);

    const row = await prisma.erp_sync_state.findUniqueOrThrow({ where: { interface_code: CODE } });
    expect(row.requested_by).toBe(users.operator);

    const status = await request(app.getHttpServer()).get(PATH).set('Cookie', cookies.operator).expect(200);
    const item = status.body.items.find((i: { interfaceCode: string }) => i.interfaceCode === CODE);
    expect(item).toMatchObject({ requestedAt: first.body.requestedAt, running: false, lastFinishedAt: null });
  });

  it('⭐ 실행기는 돌기 시작한 시각까지의 요청만 지운다 — 도는 사이에 또 누른 요청은 남는다', async () => {
    const state = new SyncState(prisma);
    const pressedAt = new Date('2026-10-20T08:00:00.000Z');
    await prisma.erp_sync_state.upsert({
      where: { interface_code: CODE },
      create: { interface_code: CODE, requested_at: pressedAt, requested_by: users.operator },
      update: { requested_at: pressedAt, requested_by: users.operator },
    });

    await state.clearRequest(CODE, new Date(pressedAt.getTime() - 1_000));
    expect((await prisma.erp_sync_state.findUniqueOrThrow({ where: { interface_code: CODE } })).requested_at).toEqual(pressedAt);

    await state.clearRequest(CODE, pressedAt);
    expect(await prisma.erp_sync_state.findUniqueOrThrow({ where: { interface_code: CODE } })).toMatchObject({
      requested_at: null,
      requested_by: null,
    });
  });

  async function cleanup(): Promise<void> {
    await prisma.erp_sync_state.deleteMany({ where: { interface_code: { in: [CODE, 'IF-NOPE'] } } });
    const roles = { role_code: { startsWith: `${PREFIX}-` } };
    await prisma.user_role.deleteMany({ where: { role: roles } });
    await prisma.role_permission.deleteMany({ where: { role: roles } });
    await prisma.role.deleteMany({ where: roles });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
