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
  const totalOf = async (query: Record<string, unknown> = {}) =>
    ((await list(query).expect(200)).body as { page: { total: number } }).page.total;
  const detail = (key: string) => request(app.getHttpServer()).get(`${BASE}/${ids[key]}`).set('Cookie', cookie);
  const acknowledge = (key: string) => request(app.getHttpServer()).post(`${BASE}/${ids[key]}:acknowledge`)
    .set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', '1').send({ decisionCode: 'APPLY' });
  const resync = (key: string) => request(app.getHttpServer()).post(`${BASE}/${ids[key]}:resync`)
    .set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({});
  const autoPlan = (key: string) => request(app.getHttpServer()).post(`${BASE}/${ids[key]}:auto-plan`)
    .set('Cookie', cookie).set('Idempotency-Key', randomUUID());

  it('공장 범위 — 목록은 그 공장 오더만(기본 Prisma 경로 total 포함), 범위 밖 plantId 는 403', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    expect(await noOf()).toEqual(['P1', 'A1', 'C1']);
    expect(await totalOf()).toBe(3);
    expect(await noOf({ plantId: Number(ids.plant1) })).toEqual(['P1', 'A1', 'C1']);
    const denied = await list({ plantId: Number(ids.plant3) }).expect(403);
    expect(denied.body).toEqual({
      errors: [{ scope: 'field', field: 'plantId', code: 'PERMISSION_DENIED', message: '이 공장에 대한 데이터 권한이 없습니다.' }],
    });
    await list({ plantId: Number(ids.plant2) }).expect(403);
  });

  it('공장 범위 — 칩 건수(size=1 의 total)와 자동 계획 상태 필터도 범위 안만 센다', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    expect(await totalOf({ worklistState: 'CANCELLED', size: 1 })).toBe(1);
    expect(await noOf({ worklistState: 'CANCELLED' })).toEqual(['P1']);
    expect(await totalOf({ worklistState: 'ACTION_REQUIRED', size: 1 })).toBe(2);
    expect(await noOf({ autoPlanStatus: 'NEEDS_REVIEW' })).toEqual(['A1', 'C1']);
    await list({ worklistState: 'CANCELLED', plantId: Number(ids.plant3) }).expect(403);
    await list({ autoPlanStatus: 'NEEDS_REVIEW', plantId: Number(ids.plant3) }).expect(403);

    await setScopes([]);
    expect(await totalOf({ worklistState: 'CANCELLED', size: 1 })).toBe(4);
    expect(await noOf({ autoPlanStatus: 'NEEDS_REVIEW' })).toEqual(['A1', 'A3', 'C1', 'C3', 'CX']);
  });

  it('공장 범위 — 확인 안 한 것만 보기(unacknowledgedOnly)도 범위 안만', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);
    // A1 은 확인됨이라 빠지고, 범위 밖 A3 은 확인 안 했어도 안 보인다.
    expect(await noOf({ unacknowledgedOnly: true })).toEqual(['P1', 'C1']);
    expect(await noOf({ unacknowledgedOnly: true, worklistState: 'ACTION_REQUIRED' })).toEqual(['C1']);

    await setScopes([]);
    expect(await noOf({ unacknowledgedOnly: true })).toEqual(['P1', 'P2', 'P3', 'P4', 'A3', 'C1', 'C3', 'CX']);
  });

  it('공장 범위 — 하위 포함 조회는 루트도 하위도 범위 안만(Prisma 경로와 SQL 경로 모두)', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    // CX 는 A1 의 하위지만 다른 공장이라 보이지 않는다.
    expect(await noOf({ includeChildren: true })).toEqual(['P1', 'A1', 'C1']);
    expect(await totalOf({ includeChildren: true })).toBe(2);
    expect(await noOf({ includeChildren: true, worklistState: 'ACTION_REQUIRED' })).toEqual(['A1', 'C1']);
    expect(await noOf({ includeChildren: true, autoPlanStatus: 'NEEDS_REVIEW' })).toEqual(['A1', 'C1']);

    await setScopes([{ plant_id: ids.plant3 }]);
    expect(await noOf({ includeChildren: true })).toEqual(['P3', 'A3', 'C3']);
    expect(await noOf({ includeChildren: true, worklistState: 'ACTION_REQUIRED' })).toEqual(['A3', 'C3']);

    await setScopes([]);
    expect(await noOf({ includeChildren: true, worklistState: 'ACTION_REQUIRED' })).toEqual(['A1', 'A3', 'C1', 'C3', 'CX']);
  });

  it('공장 범위 — 단건·자동 계획·확인·재동기는 범위 밖이면 404', async () => {
    await setScopes([{ plant_id: ids.plant1 }]);

    await detail('P1').expect(200);
    await detail('P3').expect(404);
    // 취소된 오더라 범위 안이면 계획 전에 400 STATE_LOCKED 로 멈춘다 — 범위 밖은 그 앞에서 404 다.
    const locked = await autoPlan('P1').expect(400);
    expect(JSON.stringify(locked.body)).toContain('STATE_LOCKED');
    await autoPlan('P3').expect(404);

    await acknowledge('P3').expect(404);
    await resync('P3').expect(404);
    await resync('P1').expect(202);
    expect(await prisma.integration_message.count({ where: { target_type_code: 'PRODUCTION_ORDER', target_id: ids.P3 } })).toBe(0);
    // 범위 안이면 범위를 지나 확인 처리에 닿는다 — 받은 변경이 없는 오더라 400 STATE_LOCKED 로 멈춘다.
    const unchanged = await acknowledge('P1').expect(400);
    expect(JSON.stringify(unchanged.body)).toContain('STATE_LOCKED');
  });

  it('사업부 범위 — 그 사업부의 공장 전부', async () => {
    await setScopes([{ business_unit_id: ids.unit1 }]);

    expect(await noOf()).toEqual(['P1', 'P2', 'A1', 'C1']);
    await list({ plantId: Number(ids.plant2) }).expect(200);
    await list({ plantId: Number(ids.plant3) }).expect(403);
    await detail('P2').expect(200);
    await detail('P3').expect(404);
  });

  it('법인 범위 — 그 법인의 공장 전부, 다른 법인은 403·404', async () => {
    await setScopes([{ legal_entity_id: ids.entity1 }]);

    expect(await noOf()).toEqual(['P1', 'P2', 'P3', 'A1', 'A3', 'C1', 'C3', 'CX']);
    await list({ plantId: Number(ids.plant3) }).expect(200);
    await list({ plantId: Number(ids.plant4) }).expect(403);
    await detail('P3').expect(200);
    await detail('P4').expect(404);
  });

  it('여러 줄은 합친다 — 공장 + 다른 사업부의 공장', async () => {
    await setScopes([{ plant_id: ids.plant1 }, { business_unit_id: ids.unit2 }]);

    expect(await noOf()).toEqual(['P1', 'P3', 'A1', 'A3', 'C1', 'C3', 'CX']);
    await list({ plantId: Number(ids.plant2) }).expect(403);
  });

  it('범위는 있는데 공장이 하나도 안 남으면 빈 목록 200 이고 어느 plantId 도 403', async () => {
    // 이 법인 아래 공장이 없다.
    await setScopes([{ legal_entity_id: ids.emptyEntity }]);

    expect(await noOf()).toEqual([]);
    await list({ plantId: Number(ids.plant1) }).expect(403);
    await detail('P1').expect(404);
  });

  it('범위가 없으면 지금처럼 전체 공장', async () => {
    await setScopes([]);

    expect(await noOf()).toEqual(['P1', 'P2', 'P3', 'P4', 'A1', 'A3', 'C1', 'C3', 'CX']);
    await list({ plantId: Number(ids.plant4) }).expect(200);
    await detail('P4').expect(200);
    expect(JSON.stringify((await autoPlan('P4').expect(400)).body)).toContain('STATE_LOCKED');
  });

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    // 조회·자동 계획 W-02-01 · 확인 W-02-06 · 재동기 W-06-10.
    await prisma.role_permission.createMany({
      data: ['W-02-01', 'W-02-06', 'W-06-10'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;

    const legal = (code: string) => prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-${code}`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const entity1 = await legal('LE1');
    const entity2 = await legal('LE2');
    ids.entity1 = entity1.legal_entity_id;
    ids.emptyEntity = (await legal('LE3')).legal_entity_id;
    const unit = (code: string, legalEntityId: bigint) => prisma.business_unit.create({ data: {
      legal_entity_id: legalEntityId, business_unit_code: `${PREFIX}-${code}`, business_unit_name: PREFIX,
    } });
    ids.unit1 = (await unit('BU1', ids.entity1)).business_unit_id;
    ids.unit2 = (await unit('BU2', ids.entity1)).business_unit_id;
    const unit3 = (await unit('BU3', entity2.legal_entity_id)).business_unit_id;
    const plant = (code: string, legalEntityId: bigint, businessUnitId: bigint) => prisma.plant.create({ data: {
      legal_entity_id: legalEntityId, business_unit_id: businessUnitId, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX,
      timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant1 = (await plant('P1', ids.entity1, ids.unit1)).plant_id;
    ids.plant2 = (await plant('P2', ids.entity1, ids.unit1)).plant_id;
    ids.plant3 = (await plant('P3', ids.entity1, ids.unit2)).plant_id;
    ids.plant4 = (await plant('P4', entity2.legal_entity_id, unit3)).plant_id;
    const unitOf: Record<string, bigint> = {
      [String(ids.plant1)]: ids.unit1, [String(ids.plant2)]: ids.unit1, [String(ids.plant3)]: ids.unit2, [String(ids.plant4)]: unit3,
    };
    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    const item = await prisma.item.create({ data: { item_code: `${PREFIX}-IT`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id } });

    // 만든 순서가 목록 순서다(계획 시작일·납기가 없으면 id 순). 취소 오더는 칩 CANCELLED, 그 밖은 시도했으나 계획이 없어 ACTION_REQUIRED·NEEDS_REVIEW.
    const order = async (key: string, plantId: bigint, opts: { cancelled?: boolean; parent?: string } = {}) => {
      const row = await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-${key}`, business_unit_id: unitOf[String(plantId)], plant_id: plantId, item_id: item.item_id,
        order_qty: 10, uom_id: uom.uom_id, status_code: opts.cancelled === true ? 'CANCELLED' : 'CONFIRMED',
        auto_plan_attempted_at: opts.cancelled === true ? null : new Date(),
        parent_production_order_id: opts.parent === undefined ? null : ids[opts.parent],
        bom_level: opts.parent === undefined ? 0 : 1,
      } });
      ids[key] = row.production_order_id;
    };
    await order('P1', ids.plant1, { cancelled: true });
    await order('P2', ids.plant2, { cancelled: true });
    await order('P3', ids.plant3, { cancelled: true });
    await order('P4', ids.plant4, { cancelled: true });
    await order('A1', ids.plant1);
    await order('A3', ids.plant3);
    await order('C1', ids.plant1, { parent: 'A1' });
    await order('C3', ids.plant3, { parent: 'A3' });
    // A1 의 하위인데 다른 공장 — 루트의 범위를 따라가지 않고 자기 공장으로 거른다.
    await order('CX', ids.plant3, { parent: 'A1' });
    await prisma.production_order_acknowledgement.create({ data: {
      production_order_id: ids.A1, acknowledgement_type_code: 'PO_CHANGE', received_at: new Date(), acknowledged_at: new Date(),
      status_code: 'ACKNOWLEDGED', acknowledged_by: userId, acknowledge_decision_code: 'APPLY',
    } });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    const userIds = users.map((row) => row.app_user_id);
    // 범위 줄이 공장·법인을 가리키므로 가장 먼저 지운다.
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    const orders = { production_order: { production_order_no: { startsWith: PREFIX } } };
    await prisma.production_order_acknowledgement.deleteMany({ where: orders });
    const orderIds = (await prisma.production_order.findMany({ where: { production_order_no: { startsWith: PREFIX } }, select: { production_order_id: true } }))
      .map((row) => row.production_order_id);
    await prisma.integration_message.deleteMany({ where: { target_type_code: 'PRODUCTION_ORDER', target_id: { in: orderIds } } });
    await prisma.production_order.updateMany({ where: { production_order_no: { startsWith: PREFIX } }, data: { parent_production_order_id: null } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
