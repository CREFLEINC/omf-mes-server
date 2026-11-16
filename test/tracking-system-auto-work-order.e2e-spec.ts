/**
 * OA 자동 W/O — ERP W/O 한 건을 계획·확정·배포까지 사람 없이(flowtrack 연동 제안 §7 · 사용자 결정 2026-11-05 · 11-16).
 *
 * Routing 이 없는 품목은 공장 정책 `AUTO_ROUTING_PROCESS` 의 공정으로 1공정 Routing 을 만든다. BOM 은 그 공장의 기본 BOM 이어야 한다.
 * 배포한 W/O 는 라인·WIP·스크랩 위치가 없고 완제품 위치는 ERP W/O 의 창고(SL_CD)다. 기록자는 비운다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AutoWorkOrderService } from '../src/integration/tracking-system/auto-work-order.service';
import { plantToday } from '../src/planning/routing/routing.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_AWO_${randomUUID().slice(0, 8)}`;
const SL_CD = 'S510';
const START = new Date('2026-01-05T00:00:00.000Z');

describe('OA 자동 W/O (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auto: AutoWorkOrderService;
  let seq = 0;
  const ids: Record<string, bigint> = {};
  const items: Record<string, { id: bigint; code: string; bomId: bigint }> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    auto = app.get(AutoWorkOrderService);
    await fixtures();
  });

  afterAll(async () => {
    await prisma.operation_policy.deleteMany({ where: { plant_id: ids.plant } });
    await app.close();
  });

  it('Routing 없는 품목 — 정책 공정으로 1공정 Routing 을 확정·기본으로 만들고, 계획을 세워 확정하고, W/O 를 라인 없이 배포한다', async () => {
    const orderId = await order('A');
    await auto.run(orderId);

    const routings = await prisma.routing.findMany({ where: { item_id: items.A.id }, include: { routing_operation: true } });
    expect(routings).toEqual([expect.objectContaining({
      routing_code: `RT-${items.A.code}-01`, routing_version: 1, status_code: 'CONFIRMED', is_default: true, effective_from: null,
      confirmed_at: expect.any(Date),
    })]);
    expect(routings[0].routing_operation).toEqual([expect.objectContaining({
      operation_seq: 10, process_id: ids.process, operation_name: '조립', production_result_managed: true,
      inspection_managed: false, equipment_required: false, mold_required: false, material_input_managed: false,
    })]);
    const audit = await prisma.audit_event.findMany({ where: { target_type_code: 'ROUTING', target_id: routings[0].routing_id } });
    expect(audit).toEqual([expect.objectContaining({ event_type_code: 'CREATE', performed_by: null })]);

    const plans = await prisma.production_plan.findMany({ where: { production_order_id: orderId } });
    expect(plans).toEqual([expect.objectContaining({
      status_code: 'CONFIRMED', created_automatically: true, plan_date_source_code: 'SYSTEM', bom_id: items.A.bomId,
      routing_id: routings[0].routing_id, created_by: null, confirmed_by: null,
      plan_date: new Date(`${await plantToday(prisma, ids.plant)}T00:00:00.000Z`),
    })]);
    expect(plans[0].planned_qty.toNumber()).toBe(10);

    const workOrders = await prisma.work_order.findMany({ where: { production_plan_id: plans[0].production_plan_id } });
    expect(workOrders).toEqual([expect.objectContaining({
      status_code: 'RELEASED', released_at: expect.any(Date), production_line_id: null, default_wip_location_id: null,
      default_scrap_location_id: null, default_fg_location_id: ids.fgLocation, updated_by: null,
    })]);
    const lots = await prisma.lot.findMany({ where: { source_type_code: 'WORK_ORDER', source_id: workOrders[0].work_order_id } });
    expect(lots.map((lot) => [lot.initial_qty.toNumber(), lot.created_by])).toEqual([[10, null]]);
    expect(await prisma.notification_event.count({
      where: { aggregate_type_code: 'WORK_ORDER', aggregate_id: workOrders[0].work_order_id },
    })).toBe(0);
  });

  it('다시 돌려도 그대로다 — Routing·계획·W/O·LOT 을 더 만들지 않는다', async () => {
    const orderId = await order('A');
    await auto.run(orderId);
    const before = await snapshot(orderId);
    await auto.run(orderId);
    expect(await snapshot(orderId)).toEqual(before);
  });

  it('끊긴 자동 계획(작성중)은 이어서 확정하고 배포한다', async () => {
    const orderId = await order('A');
    const routing = await prisma.routing.findFirstOrThrow({ where: { item_id: items.A.id } });
    await prisma.production_plan.create({ data: {
      production_order_id: orderId, plan_no: `${PREFIX}-PP-${++seq}`, plan_date: START, planned_qty: 10, uom_id: ids.uom,
      bom_id: items.A.bomId, routing_id: routing.routing_id, status_code: 'DRAFT', created_automatically: true,
    } });
    await auto.run(orderId);

    const plan = await prisma.production_plan.findFirstOrThrow({ where: { production_order_id: orderId }, include: { work_order: true } });
    expect(plan.status_code).toBe('CONFIRMED');
    expect(plan.work_order.map((workOrder) => workOrder.status_code)).toEqual(['RELEASED']);
  });

  it('쓸 수 있는 Routing 이 있으면 그것을 쓰고 만들지 않는다', async () => {
    const orderId = await order('D');
    await auto.run(orderId);
    expect(await prisma.routing.count({ where: { item_id: items.D.id } })).toBe(1);
    const plan = await prisma.production_plan.findFirstOrThrow({ where: { production_order_id: orderId } });
    expect(plan.routing_id).toBe(ids.routingD);
  });

  it('쓸 수 없는 Routing(작성중)만 있으면 만들지 않고 까닭을 던진다 — 계획도 없다', async () => {
    const orderId = await order('B');
    await expect(auto.run(orderId)).rejects.toThrow('작성중·폐기이거나 유효 기간 밖');
    expect(await prisma.routing.count({ where: { item_id: items.B.id } })).toBe(1);
    expect(await prisma.production_plan.count({ where: { production_order_id: orderId } })).toBe(0);
  });

  it('기본 BOM 이 다른 공장의 것이면 까닭을 던진다 — Routing 도 만들지 않는다', async () => {
    const orderId = await order('C');
    await expect(auto.run(orderId)).rejects.toThrow('이 공장의 것이 아닙니다');
    expect(await prisma.routing.count({ where: { item_id: items.C.id } })).toBe(0);
    expect(await prisma.production_plan.count({ where: { production_order_id: orderId } })).toBe(0);
  });

  it('사람이 세운 계획이 있는 ERP W/O 는 건드리지 않는다', async () => {
    const orderId = await order('D');
    const plan = await prisma.production_plan.create({ data: {
      production_order_id: orderId, plan_no: `${PREFIX}-PP-${++seq}`, plan_date: START, planned_qty: 4, uom_id: ids.uom,
      bom_id: items.D.bomId, routing_id: ids.routingD, status_code: 'DRAFT',
    } });
    await auto.run(orderId);
    expect(await prisma.production_plan.findMany({ where: { production_order_id: orderId } })).toEqual([
      expect.objectContaining({ production_plan_id: plan.production_plan_id, status_code: 'DRAFT', version_no: 1 }),
    ]);
  });

  async function snapshot(orderId: bigint) {
    const plans = await prisma.production_plan.findMany({ where: { production_order_id: orderId }, select: { production_plan_id: true, version_no: true } });
    const workOrders = await prisma.work_order.findMany({
      where: { production_plan_id: { in: plans.map((plan) => plan.production_plan_id) } },
      select: { work_order_id: true, version_no: true },
    });
    return {
      routings: await prisma.routing.count({ where: { item_id: items.A.id } }),
      plans,
      workOrders,
      lots: await prisma.lot.count({ where: { source_type_code: 'WORK_ORDER', source_id: { in: workOrders.map((row) => row.work_order_id) } } }),
    };
  }

  async function order(item: string): Promise<bigint> {
    const row = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${++seq}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: items[item].id,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED', erp_storage_location_code: SL_CD, planned_start_date: START,
    } });
    return row.production_order_id;
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    ids.plant = (await prisma.plant.create({ data: {
      plant_code: PREFIX, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    ids.process = (await prisma.process.create({ data: {
      process_code: `${PREFIX}-ASSY`, process_name: '조립', process_type_code: 'ASSEMBLY',
    } })).process_id;
    await prisma.operation_policy.create({ data: {
      policy_code: 'AUTO_ROUTING_PROCESS', plant_id: ids.plant, value_text: `${PREFIX}-ASSY`, effective_from: new Date('2026-01-01T00:00:00.000Z'),
    } });
    const warehouse = await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: SL_CD, warehouse_name: PREFIX,
      warehouse_type_code: 'PRODUCT', management_level_code: 'WAREHOUSE',
    } });
    ids.fgLocation = (await prisma.location.findFirstOrThrow({
      where: { warehouse_id: warehouse.warehouse_id, system_role_code: 'WAREHOUSE_WHOLE' },
    })).location_id;

    // A Routing 없음 · B 작성중 Routing 만 · C 기본 BOM 이 다른 공장 · D 쓸 수 있는 Routing 있음.
    for (const key of ['A', 'B', 'C', 'D']) {
      const code = `${PREFIX}-${key}`;
      const item = await prisma.item.create({ data: { item_code: code, item_name: code, item_type_code: 'FINISHED', base_uom_id: ids.uom } });
      const bom = await prisma.bom.create({ data: {
        parent_item_id: item.item_id, plant_id: key === 'C' ? base.plant_id : ids.plant, bom_code: `ERP-${code}`, bom_version: 1,
        status_code: 'CONFIRMED', is_default: true, effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
      } });
      items[key] = { id: item.item_id, code, bomId: bom.bom_id };
    }
    await prisma.routing.create({ data: { item_id: items.B.id, routing_code: `RT-${items.B.code}-01`, routing_version: 1, status_code: 'DRAFT' } });
    const routingD = await prisma.routing.create({ data: {
      item_id: items.D.id, routing_code: `RT-${items.D.code}-01`, routing_version: 1, status_code: 'CONFIRMED',
    } });
    await prisma.routing_operation.create({ data: {
      routing_id: routingD.routing_id, operation_seq: 10, process_id: ids.process, operation_name: '조립',
    } });
    ids.routingD = routingD.routing_id;
  }
});
