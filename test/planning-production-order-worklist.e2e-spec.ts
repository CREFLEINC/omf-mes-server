/**
 * ERP W/O 목록의 「작업지시 목록」 칩 판정 `worklistState` — 응답 칸과 필터(장부 P-142) (e2e).
 *
 * 다섯 판정의 경계: 계획 전 · 자동 계획 확인 필요 · W/O 0건 DONE · 일부 배포 · 라인 빈 W/O 와 정상 W/O 섞임 ·
 * 다른 공장 라인 · W/O 전부 취소 · 전부 배포(취소 W/O 섞임) · 취소된 오더 · 기준정보가 뒤늦게 갖춰진 자동 계획 확인 필요. 칩 건수는 `size=1` 의 total 로 센다(클라이언트와 같다).
 * 조치 필요 까닭 `worklistReasons` 와, 그 까닭이 배포 전제 검사(`releasePlan`)가 실제로 막는 W/O 와 같은지도 본다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { NumberingService } from '../src/core/numbering/numbering.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { releasePlan } from '../src/production/work-order/release-plan';

const PREFIX = 'WLS204';
const BASE = '/api/planning/production-orders';

interface Row { productionOrderNo: string; worklistState: string; autoPlan: { status: string; reasons: string[] } | null; worklistReasons?: { code: string; workOrderCount: number }[]; releasePendingWorkOrderCount: number; liveWorkOrderCount: number }

describe('ERP W/O 작업지시 목록 칩 판정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};
  /** 배포 전 W/O 와 그 W/O 의 배포가 막히는지(픽스처가 정한 기대). */
  const pending: { workOrderId: bigint; blocked: boolean }[] = [];

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

  const list = (query: Record<string, unknown>) =>
    request(app.getHttpServer()).get(BASE).query({ plantId: Number(ids.plant), size: 100, ...query }).set('Cookie', cookie);
  const stateOf = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.productionOrderNo.replace(`${PREFIX}-`, ''), row.worklistState]));

  it('목록 행마다 worklistState 를 싣는다 — 다섯 판정의 경계', async () => {
    const body = (await list({}).expect(200)).body as { items: Row[] };

    expect(stateOf(body.items)).toEqual({
      BEFORE: 'BEFORE_PLAN',
      REVIEW: 'ACTION_REQUIRED',
      NOWO: 'ACTION_REQUIRED',
      PARTIAL: 'RELEASE_PENDING',
      MIXED: 'ACTION_REQUIRED',
      OTHERPLANT: 'ACTION_REQUIRED',
      ALLCANCELLED: 'ACTION_REQUIRED',
      RERUN: 'ACTION_REQUIRED',
      DONE: 'RELEASED',
      CANCEL: 'CANCELLED',
    });
  });

  it('조치 필요이고 자동 계획 DONE 이면 worklistReasons 에 까닭과 W/O 수를 싣는다', async () => {
    const body = (await list({}).expect(200)).body as { items: Row[] };
    const reasons = Object.fromEntries(body.items.map((row) => [row.productionOrderNo.replace(`${PREFIX}-`, ''), row.worklistReasons]));

    expect(reasons).toEqual({
      BEFORE: undefined,
      REVIEW: undefined,
      NOWO: [{ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 }],
      PARTIAL: undefined,
      MIXED: [
        { code: 'WORK_ORDER_LINE_MISSING', workOrderCount: 1 },
        { code: 'WORK_ORDER_LOCATION_MISSING', workOrderCount: 1 },
      ],
      OTHERPLANT: [{ code: 'LINE_PLANT_MISMATCH', workOrderCount: 1 }],
      ALLCANCELLED: [{ code: 'NO_LIVE_WORK_ORDER', workOrderCount: 0 }],
      RERUN: undefined,
      DONE: undefined,
      CANCEL: undefined,
    });
  });

  it('모든 행에 배포 전 W/O 수 / 살아 있는 W/O 수를 싣는다 — 판정과 같은 정의', async () => {
    const body = (await list({}).expect(200)).body as { items: Row[] };
    const counts = Object.fromEntries(body.items.map((row) => [
      row.productionOrderNo.replace(`${PREFIX}-`, ''), `${row.releasePendingWorkOrderCount}/${row.liveWorkOrderCount}`,
    ]));

    expect(counts).toEqual({
      BEFORE: '0/0',
      REVIEW: '0/0',
      NOWO: '0/0',
      PARTIAL: '1/2',
      MIXED: '3/3',
      OTHERPLANT: '1/1',
      ALLCANCELLED: '0/0',
      RERUN: '0/0',
      DONE: '0/1',
      CANCEL: '0/0',
    });
  });

  it('조치 필요는 까닭이 늘 있다 — DONE 이면 worklistReasons, 확인 필요면 autoPlan.reasons. 까닭이 있으면 조치 필요다', async () => {
    const body = (await list({}).expect(200)).body as { items: Row[] };
    for (const row of body.items) {
      const done = row.worklistState === 'ACTION_REQUIRED' && row.autoPlan?.status === 'DONE';
      const review = row.worklistState === 'ACTION_REQUIRED' && row.autoPlan?.status === 'NEEDS_REVIEW';
      expect({ no: row.productionOrderNo, worklist: (row.worklistReasons?.length ?? 0) > 0, autoPlan: (row.autoPlan?.reasons.length ?? 0) > 0 })
        .toEqual({ no: row.productionOrderNo, worklist: done, autoPlan: review });
    }
  });

  it('시도했지만 계획이 없고 기준정보가 이제 갖춰졌으면 autoPlan.reasons 가 AUTO_PLAN_RERUN_NEEDED 다', async () => {
    const body = (await list({ q: `${PREFIX}-RERUN` }).expect(200)).body as { items: Row[] };
    expect(body.items.map((row) => row.autoPlan)).toEqual([{ status: 'NEEDS_REVIEW', reasons: ['AUTO_PLAN_RERUN_NEEDED'] }]);
  });

  it('배포 대기·조치 필요 판정이 배포 전제 검사와 같다 — 막힌다고 본 W/O 만 releasePlan 이 400 이다', async () => {
    const numbering = app.get(NumberingService);
    const actual = [];
    for (const row of pending) {
      const blocked = await releasePlan(prisma, numbering, Number(row.workOrderId), 1).then(() => false, (error: { getStatus?: () => number }) => {
        if (error.getStatus?.() !== 400) throw error;
        return true;
      });
      actual.push({ workOrderId: row.workOrderId, blocked });
    }
    expect(actual).toEqual(pending);
  });

  it('worklistState 로 거르면 그 판정만 오고, size=1 의 total 이 칩 건수다', async () => {
    const totals: Record<string, number> = {};
    for (const state of ['BEFORE_PLAN', 'ACTION_REQUIRED', 'RELEASE_PENDING', 'RELEASED', 'CANCELLED']) {
      const all = (await list({ worklistState: state }).expect(200)).body as { items: Row[] };
      expect(all.items.every((row) => row.worklistState === state)).toBe(true);
      totals[state] = ((await list({ worklistState: state, size: 1 }).expect(200)).body as { page: { total: number } }).page.total;
      expect(totals[state]).toBe(all.items.length);
    }
    expect(totals).toEqual({ BEFORE_PLAN: 1, ACTION_REQUIRED: 6, RELEASE_PENDING: 1, RELEASED: 1, CANCELLED: 1 });
  });

  it('autoPlanStatus 와 함께 걸린다 — DONE 중 배포 대기만', async () => {
    const body = (await list({ autoPlanStatus: 'DONE', worklistState: 'RELEASE_PENDING' }).expect(200)).body as { items: Row[] };
    expect(body.items.map((row) => row.productionOrderNo)).toEqual([`${PREFIX}-PARTIAL`]);
  });

  it('계획 시작일 필터가 autoPlanStatus·worklistState 와 함께 걸린다 — 하나는 남고 하나는 빠진다', async () => {
    const numbers = async (query: Record<string, unknown>) =>
      ((await list(query).expect(200)).body as { items: Row[] }).items.map((row) => row.productionOrderNo.replace(`${PREFIX}-`, '')).sort();

    expect(await numbers({ autoPlanStatus: 'DONE', plannedStartDateFrom: '2026-10-15' })).toEqual(['PARTIAL']);
    expect(await numbers({ autoPlanStatus: 'DONE', plannedStartDateTo: '2026-10-15' })).toEqual(['DONE']);
    expect(await numbers({ worklistState: 'RELEASED', plannedStartDateFrom: '2026-10-15' })).toEqual([]);
    expect(await numbers({ worklistState: 'RELEASED', plannedStartDateTo: '2026-10-15' })).toEqual(['DONE']);
  });

  it('칩 값이 아니면 400 이고 고칠 값을 알린다', async () => {
    const response = await list({ worklistState: 'NOPE' }).expect(400);
    expect(JSON.stringify(response.body)).toContain('worklistState');
  });

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-01' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX } });
    const plant = (code: string) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant = (await plant('P1')).plant_id;
    const otherPlant = (await plant('P2')).plant_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    const item = await prisma.item.create({ data: { item_code: `${PREFIX}-IT`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id } });
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } });
    const routing = await prisma.routing.create({ data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX } });
    const bom = await prisma.bom.create({ data: {
      parent_item_id: item.item_id, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'ACTIVE',
      effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: uom.uom_id,
    } });
    const line = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-L1`, line_name: PREFIX } })).production_line_id;
    const foreignLine = (await prisma.production_line.create({ data: { plant_id: otherPlant, line_code: `${PREFIX}-L2`, line_name: PREFIX } })).production_line_id;
    const warehouse = await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`, warehouse_name: PREFIX,
      warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION',
    } });
    const location = (await prisma.location.create({ data: {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: PREFIX, location_type_code: 'DEFAULT',
    } })).location_id;

    // 자동 계획이 지금 돌면 확정까지 가는 품목 — 기본 BOM · 확정 Routing · 라인에 속한 기본 매핑 설비.
    const readyItem = await prisma.item.create({ data: { item_code: `${PREFIX}-IT-RR`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id } });
    await prisma.bom.create({ data: {
      parent_item_id: readyItem.item_id, bom_code: `${PREFIX}-BOM-RR`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
      effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: uom.uom_id,
    } });
    const readyRouting = await prisma.routing.create({ data: { item_id: readyItem.item_id, routing_code: `${PREFIX}-RT-RR`, routing_version: 1, status_code: 'CONFIRMED' } });
    await prisma.routing_operation.create({ data: {
      routing_id: readyRouting.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX, equipment_required: true,
    } });
    const equipment = await prisma.equipment.create({ data: {
      plant_id: ids.plant, equipment_code: `${PREFIX}-EQ`, equipment_name: PREFIX, equipment_type_code: 'PRESS', status_code: 'IN_SERVICE', production_line_id: line,
    } });
    await prisma.item_resource_map.create({ data: { plant_id: ids.plant, item_id: readyItem.item_id, equipment_id: equipment.equipment_id, is_default: true } });

    let seq = 0;
    const order = async (key: string, opts: { status?: string; attempted?: boolean; planned?: number; itemId?: bigint; plannedStart?: string } = {}) => {
      const row = await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-${key}`, business_unit_id: unit.business_unit_id, plant_id: ids.plant, item_id: opts.itemId ?? item.item_id,
        order_qty: 10, uom_id: uom.uom_id, status_code: opts.status ?? 'CONFIRMED',
        auto_plan_attempted_at: opts.attempted === true ? new Date() : null,
        planned_start_date: opts.plannedStart === undefined ? null : new Date(`${opts.plannedStart}T00:00:00.000Z`),
      } });
      if (opts.planned === undefined) return { orderId: row.production_order_id, planId: null };
      const plan = await prisma.production_plan.create({ data: {
        production_order_id: row.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: new Date('2026-10-28T00:00:00.000Z'),
        planned_qty: opts.planned, uom_id: uom.uom_id, bom_id: bom.bom_id, routing_id: routing.routing_id,
        status_code: 'CONFIRMED', confirmed_at: new Date(),
      } });
      return { orderId: row.production_order_id, planId: plan.production_plan_id };
    };
    const workOrder = async (planId: bigint | null, opts: { released?: boolean; status?: string; line?: bigint | null; locations?: boolean } = {}) => {
      seq += 1;
      const withLocations = opts.locations ?? true;
      const row = await prisma.work_order.create({ data: {
        work_order_no: `${PREFIX}-WO-${seq}`, production_plan_id: planId, routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id, order_qty: 5, uom_id: uom.uom_id,
        status_code: opts.status ?? (opts.released === true ? 'RELEASED' : 'PLANNED'),
        released_at: opts.released === true ? new Date() : null,
        production_line_id: opts.line === undefined ? line : opts.line,
        default_wip_location_id: withLocations ? location : null,
        default_fg_location_id: withLocations ? location : null,
        default_scrap_location_id: withLocations ? location : null,
      } });
      if (opts.released !== true && opts.status === undefined) {
        pending.push({ workOrderId: row.work_order_id, blocked: opts.line !== undefined || !withLocations });
      }
    };

    await order('BEFORE');
    await order('REVIEW', { attempted: true, planned: 4 });
    await order('NOWO', { planned: 10 });
    const partial = await order('PARTIAL', { planned: 10, plannedStart: '2026-11-01' });
    await workOrder(partial.planId, { released: true });
    await workOrder(partial.planId);
    const mixed = await order('MIXED', { planned: 10 });
    await workOrder(mixed.planId);
    await workOrder(mixed.planId, { line: null });
    await workOrder(mixed.planId, { locations: false });
    const otherPlantLine = await order('OTHERPLANT', { planned: 10 });
    await workOrder(otherPlantLine.planId, { line: foreignLine });
    const done = await order('DONE', { planned: 10, plannedStart: '2026-10-01' });
    await workOrder(done.planId, { released: true });
    // 취소된 W/O 는 배포 전으로 세지 않는다 — 라인·위치가 비어 있어도.
    await workOrder(done.planId, { status: 'CANCELLED', line: null, locations: false });
    const allCancelled = await order('ALLCANCELLED', { planned: 10 });
    await workOrder(allCancelled.planId, { status: 'CANCELLED' });
    await order('CANCEL', { status: 'CANCELLED', planned: 10 });
    await order('RERUN', { attempted: true, itemId: readyItem.item_id });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item_resource_map.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: users.map((row) => row.app_user_id) } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
