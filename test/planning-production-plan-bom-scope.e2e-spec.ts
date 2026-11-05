/**
 * 생산계획 수기 등록·수정·확정의 ERP 기본 BOM 정책, 거부된 등록이 계획번호를 쓰지 않는지, 사용자 데이터 범위(공장) (e2e).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'PBS236';
const BASE = '/api/planning/production-plans';

describe('생산계획 BOM 정책 · 데이터 범위 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids = { plant: 0n, otherPlant: 0n, unit: 0n, uom: 0n, item: 0n, flipItem: 0n, routing: 0n, flipRouting: 0n };
  const boms = { old: 0n, current: 0n, flip: [] as bigint[] };
  let orderId = 0n;
  let otherOrderId = 0n;
  let otherPlanId = 0n;
  let flipOrderId = 0n;

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

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(BASE).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send(body);
  const put = (planId: bigint, version: number, body: Record<string, unknown>) =>
    request(app.getHttpServer()).put(`${BASE}/${planId}`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', String(version)).send(body);
  const confirm = (planId: bigint, version: number) =>
    request(app.getHttpServer()).post(`${BASE}/${planId}:confirm`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', String(version)).send({});
  const planBody = (overrides: Record<string, unknown> = {}) => ({
    productionOrderId: Number(orderId), planDate: '2026-12-01', plannedQty: 10, uomId: Number(ids.uom),
    bomId: Number(boms.current), routingId: Number(ids.routing), ...overrides,
  });
  const versionOf = async (planId: bigint) => (await prisma.production_plan.findUniqueOrThrow({ where: { production_plan_id: planId } })).version_no;

  describe('ERP 기본 BOM', () => {
    it('등록은 기본 BOM 이 아니면 400 BOM_NOT_DEFAULT 이고 message 에 지금 기본 개정을 적는다', async () => {
      const response = await post(planBody({ bomId: Number(boms.old) })).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: 'bomId', code: 'BOM_NOT_DEFAULT', message: expect.stringContaining(`${PREFIX}-BOM Rev 2`) }),
      ]);
    });

    it('수정은 bomId 를 보낼 때만 본다 — 옛 개정은 400, 생략은 저장값을 둔다', async () => {
      const created = await post(planBody()).expect(201);
      const planId = BigInt(created.body.productionPlanId as number);

      const rejected = await put(planId, await versionOf(planId), { bomId: Number(boms.old) }).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ field: 'bomId', code: 'BOM_NOT_DEFAULT' });
      await put(planId, await versionOf(planId), { plannedQty: 12 }).expect(200);
    });

    it('저장한 뒤 ERP 가 기본 BOM 을 바꾸면 확정은 400 이고 W/O 가 서지 않는다 — 바꾸면 확정되고, 확정된 계획은 그 뒤 기본이 바뀌어도 그대로다', async () => {
      const created = await post(planBody({ productionOrderId: Number(flipOrderId), bomId: Number(boms.flip[0]), routingId: Number(ids.flipRouting) })).expect(201);
      const planId = BigInt(created.body.productionPlanId as number);
      await flipDefault(1);

      const rejected = await confirm(planId, await versionOf(planId)).expect(400);
      expect(rejected.body.errors[0]).toMatchObject({ scope: 'field', field: 'bomId', code: 'BOM_NOT_DEFAULT' });
      expect(await prisma.work_order.count({ where: { production_plan_id: planId } })).toBe(0);

      await put(planId, await versionOf(planId), { bomId: Number(boms.flip[1]) }).expect(200);
      await confirm(planId, await versionOf(planId)).expect(200);
      await flipDefault(2);

      const detail = await request(app.getHttpServer()).get(`${BASE}/${planId}`).set('Cookie', cookie).expect(200);
      expect(detail.body).toMatchObject({ statusCode: 'CONFIRMED', bomId: Number(boms.flip[1]) });
    });
  });

  it('수량을 넘어 거부된 등록은 계획번호를 쓰지 않는다 — 다음 등록이 바로 다음 번호다', async () => {
    const order = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-NUM`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: ids.item,
      order_qty: 20, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    const body = { productionOrderId: Number(order.production_order_id), planDate: '2026-03-17' };
    const first = await post(planBody({ ...body, plannedQty: 10 })).expect(201);

    const rejected = await post(planBody({ ...body, plannedQty: 11 })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'plannedQty', code: 'PLAN_QTY_EXCEEDS_ORDER' });

    const second = await post(planBody({ ...body, plannedQty: 10 })).expect(201);
    const seq = (planNo: string): number => Number(planNo.split('-').pop());
    expect(seq(second.body.planNo as string)).toBe(seq(first.body.planNo as string) + 1);
  });

  describe('사용자 데이터 범위 — 계획의 ERP W/O 공장으로 본다', () => {
    it('목록은 범위 안 공장 것만 낸다', async () => {
      const inScope = await request(app.getHttpServer()).get(BASE).query({ productionOrderId: Number(orderId), size: 100 }).set('Cookie', cookie).expect(200);
      expect(inScope.body.items.length).toBeGreaterThan(0);
      const outOfScope = await request(app.getHttpServer()).get(BASE).query({ productionOrderId: Number(otherOrderId) }).set('Cookie', cookie).expect(200);
      expect(outOfScope.body).toMatchObject({ items: [], page: { total: 0 } });
    });

    it('범위 밖 계획의 상세·수정·확정·삭제는 404 다 — 바뀌지 않는다', async () => {
      await request(app.getHttpServer()).get(`${BASE}/${otherPlanId}`).set('Cookie', cookie).expect(404);
      await put(otherPlanId, 1, { plannedQty: 3 }).expect(404);
      await confirm(otherPlanId, 1).expect(404);
      await request(app.getHttpServer()).delete(`${BASE}/${otherPlanId}`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', '1').expect(404);
      expect(await prisma.production_plan.findUniqueOrThrow({ where: { production_plan_id: otherPlanId } })).toMatchObject({ status_code: 'DRAFT', version_no: 1 });
    });

    it('범위 밖 ERP W/O 에 등록하면 없는 ERP W/O 와 같은 400 이다', async () => {
      const response = await post(planBody({ productionOrderId: Number(otherOrderId) })).expect(400);
      expect(response.body.errors[0]).toMatchObject({ field: 'productionOrderId', code: 'INVALID' });
    });
  });

  /** 기본 BOM 을 `flip[index]` 로 옮긴다 — ERP 받기가 새 판을 올리는 것과 같다. */
  async function flipDefault(index: number): Promise<void> {
    await prisma.bom.updateMany({ where: { parent_item_id: ids.flipItem }, data: { is_default: false } });
    await prisma.bom.update({ where: { bom_id: boms.flip[index] }, data: { is_default: true } });
  }

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    await prisma.role_permission.createMany({ data: ['W-02-01', 'W-02-02'].map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX } });
    ids.unit = unit.business_unit_id;
    const plant = (code: string) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant = (await plant('P1')).plant_id;
    ids.otherPlant = (await plant('P2')).plant_id;
    await prisma.user_data_scope.create({ data: { app_user_id: user.app_user_id, plant_id: ids.plant } });
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } });

    const item = async (code: string) => (await prisma.item.create({ data: { item_code: `${PREFIX}-${code}`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom } })).item_id;
    const bom = async (itemId: bigint, code: string, version: number, isDefault: boolean) => (await prisma.bom.create({ data: {
      parent_item_id: itemId, bom_code: `${PREFIX}-${code}`, bom_version: version, status_code: 'CONFIRMED', is_default: isDefault,
      effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
    } })).bom_id;
    const routing = async (itemId: bigint, code: string) => {
      const row = await prisma.routing.create({ data: { item_id: itemId, routing_code: `${PREFIX}-${code}`, routing_version: 1, status_code: 'CONFIRMED' } });
      await prisma.routing_operation.create({ data: { routing_id: row.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX } });
      return row.routing_id;
    };

    ids.item = await item('IT');
    boms.old = await bom(ids.item, 'BOM', 1, false);
    boms.current = await bom(ids.item, 'BOM', 2, true);
    ids.routing = await routing(ids.item, 'RT');
    ids.flipItem = await item('IT-FLIP');
    boms.flip = [await bom(ids.flipItem, 'BOM-F', 1, true), await bom(ids.flipItem, 'BOM-F', 2, false), await bom(ids.flipItem, 'BOM-F', 3, false)];
    ids.flipRouting = await routing(ids.flipItem, 'RT-F');

    const order = (no: string, plantId: bigint, itemId: bigint) => prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-${no}`, business_unit_id: ids.unit, plant_id: plantId, item_id: itemId,
      order_qty: 100, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    orderId = (await order('PO-IN', ids.plant, ids.item)).production_order_id;
    otherOrderId = (await order('PO-OUT', ids.otherPlant, ids.item)).production_order_id;
    const flipOrder = await order('PO-FLIP', ids.plant, ids.flipItem);
    otherPlanId = (await prisma.production_plan.create({ data: {
      production_order_id: otherOrderId, plan_no: `${PREFIX}-PP-OUT`, plan_date: new Date('2026-12-01T00:00:00.000Z'),
      planned_qty: 5, uom_id: ids.uom, bom_id: boms.current, routing_id: ids.routing, status_code: 'DRAFT',
    } })).production_plan_id;
    flipOrderId = flipOrder.production_order_id;
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const scope = { production_order: { production_order_no: { startsWith: PREFIX } } };
    const plans = await prisma.production_plan.findMany({ where: scope, select: { production_plan_id: true } });
    await prisma.work_order.deleteMany({ where: { production_plan_id: { in: plans.map((plan) => plan.production_plan_id) } } });
    await prisma.production_plan.deleteMany({ where: scope });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    const userIds = users.map((row) => row.app_user_id);
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
