/**
 * ERP W/O 목록·건수·단건·`:auto-plan` 에 사용자 데이터 범위(공장)를 건다 (e2e).
 *
 * 범위 규칙은 대시보드 `scopedPlantWhere` 와 같다 — 줄마다 공장 > 사업부 > 법인, 줄이 없으면 제한 없음.
 * 범위 밖 `plantId` 는 403, 범위 밖 단건은 존재를 드러내지 않게 404 다.
 */
import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'POS222';
const BASE = '/api/planning/production-orders';

describe('ERP W/O 사용자 데이터 범위 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let userId: bigint;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  afterEach(() => setScopes([]));

  const setScopes = async (scopes: { business_unit_id?: bigint; plant_id?: bigint; legal_entity_id?: bigint }[]) => {
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: userId } });
    if (scopes.length > 0) await prisma.user_data_scope.createMany({ data: scopes.map((scope) => ({ app_user_id: userId, ...scope })) });
  };
  const list = (query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get(BASE).query({ q: PREFIX, size: 100, ...query }).set('Cookie', cookie);
  const noOf = async (query: Record<string, unknown> = {}) =>
    ((await list(query).expect(200)).body as { items: { productionOrderNo: string }[] }).items
      .map((row) => row.productionOrderNo.replace(`${PREFIX}-`, ''));
  const detail = (key: string) => request(app.getHttpServer()).get(`${BASE}/${ids[key]}`).set('Cookie', cookie);
  const autoPlan = (key: string) => request(app.getHttpServer()).post(`${BASE}/${ids[key]}:auto-plan`)
    .set('Cookie', cookie).set('Idempotency-Key', randomUUID());

  it('공장 범위 — 목록은 그 공장 오더만, 범위 밖 plantId 는 403', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    expect(await noOf()).toEqual(['P1']);
    expect(await noOf({ plantId: Number(ids.plant1) })).toEqual(['P1']);
    const denied = await list({ plantId: Number(ids.plant3) }).expect(403);
    expect(denied.body).toEqual({
      errors: [{ scope: 'field', field: 'plantId', code: 'PERMISSION_DENIED', message: '이 공장에 대한 데이터 권한이 없습니다.' }],
    });
    await list({ plantId: Number(ids.plant2) }).expect(403);
  });

  it('공장 범위 — 칩 건수(size=1 의 total)와 자동 계획 상태 필터도 범위 안만 센다', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    const chip = async (worklistState: string) =>
      ((await list({ worklistState, size: 1 }).expect(200)).body as { page: { total: number } }).page.total;
    expect(await chip('CANCELLED')).toBe(1);
    expect(await noOf({ worklistState: 'CANCELLED' })).toEqual(['P1']);
    await setScopes([]);
    expect(await chip('CANCELLED')).toBe(3);
    await setScopes([{ plant_id: ids.plant1 }]);
    await list({ worklistState: 'CANCELLED', plantId: Number(ids.plant3) }).expect(403);
  });

  it('공장 범위 — 하위 포함 조회도 범위 안만', async () => {
    await setScopes([{ plant_id: ids.plant3 }]);

    expect(await noOf({ includeChildren: true })).toEqual(['P3']);
  });

  it('공장 범위 — 단건과 자동 계획 재실행은 범위 밖이면 404', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    await detail('P1').expect(200);
    await detail('P3').expect(404);
    // 취소된 오더라 범위 안이면 계획 전에 400 STATE_LOCKED 로 멈춘다 — 범위 밖은 그 앞에서 404 다.
    const locked = await autoPlan('P1').expect(400);
    expect(JSON.stringify(locked.body)).toContain('STATE_LOCKED');
    await autoPlan('P3').expect(404);
  });

  it('사업부 범위 — 그 사업부의 공장 전부', async () => {
    await setScopes([{ business_unit_id: ids.unit1 }]);

    expect(await noOf()).toEqual(['P1', 'P2']);
    await list({ plantId: Number(ids.plant2) }).expect(200);
    await list({ plantId: Number(ids.plant3) }).expect(403);
    await detail('P2').expect(200);
    await detail('P3').expect(404);
  });

  it('여러 줄은 합친다 — 공장 + 다른 사업부의 공장', async () => {
    await setScopes([{ plant_id: ids.plant1 }, { business_unit_id: ids.unit2 }]);

    expect(await noOf()).toEqual(['P1', 'P3']);
    await list({ plantId: Number(ids.plant2) }).expect(403);
  });

  it('범위가 없으면 지금처럼 전체 공장', async () => {
    await setScopes([]);

    expect(await noOf()).toEqual(['P1', 'P2', 'P3']);
    await list({ plantId: Number(ids.plant3) }).expect(200);
    await detail('P3').expect(200);
    expect(JSON.stringify((await autoPlan('P3').expect(400)).body)).toContain('STATE_LOCKED');
  });

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-01' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = (code: string) => prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-${code}`, business_unit_name: PREFIX,
    } });
    const unit1 = await unit('BU1');
    const unit2 = await unit('BU2');
    ids.unit1 = unit1.business_unit_id;
    ids.unit2 = unit2.business_unit_id;
    const plant = (code: string, businessUnitId: bigint) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_id: businessUnitId, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX,
      timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant1 = (await plant('P1', ids.unit1)).plant_id;
    ids.plant2 = (await plant('P2', ids.unit1)).plant_id;
    ids.plant3 = (await plant('P3', ids.unit2)).plant_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    const item = await prisma.item.create({ data: { item_code: `${PREFIX}-IT`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id } });

    const order = async (key: string, plantId: bigint, businessUnitId: bigint) => {
      const row = await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-${key}`, business_unit_id: businessUnitId, plant_id: plantId, item_id: item.item_id,
        order_qty: 10, uom_id: uom.uom_id, status_code: 'CANCELLED',
      } });
      ids[key] = row.production_order_id;
    };
    await order('P1', ids.plant1, ids.unit1);
    await order('P2', ids.plant2, ids.unit1);
    await order('P3', ids.plant3, ids.unit2);
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    const userIds = users.map((row) => row.app_user_id);
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
