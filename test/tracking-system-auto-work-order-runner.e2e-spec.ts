/**
 * OA 자동 W/O 실행기 — 자동 라우팅 공정 정책이 있는 공장의 ERP W/O 를 한 건씩 끌고 가고, 실패는 ERP W/O 에 남긴다(사용자 결정 2026-11-16).
 * ERP 에서 취소된 ERP W/O 의 실적 없는 자동 W/O 는 취소한다(flowtrack 연동 결정 11 · PR 11).
 *
 * 실행기를 직접 만들어 `tick(now)` 를 부른다 — 시각은 검사가 움직인다. 리스는 늘 잡히는 가짜다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AutoWorkOrderRunner, RETRY_AFTER_MS } from '../src/integration/tracking-system/auto-work-order.runner';
import { AutoWorkOrderService } from '../src/integration/tracking-system/auto-work-order.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductionResultService } from '../src/production/production-result/production-result.service';

const PREFIX = `E2E_AWR_${randomUUID().slice(0, 8)}`;
const SL_CD = 'S510';

describe('OA 자동 W/O 실행기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let runner: AutoWorkOrderRunner;
  let seq = 0;
  const ids: Record<string, bigint> = {};
  const orders: Record<string, bigint> = {};
  const start = new Date();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    runner = new AutoWorkOrderRunner(
      true,
      prisma,
      { acquire: async () => true, release: async () => undefined },
      app.get(AutoWorkOrderService),
    );
    await fixtures();
  });

  afterAll(async () => {
    await prisma.operation_policy.deleteMany({ where: { plant_id: ids.plant } });
    await app.close();
  });

  const autoPlans = (orderId: bigint) =>
    prisma.production_plan.findMany({ where: { production_order_id: orderId, created_automatically: true }, include: { work_order: true } });
  const attempt = (orderId: bigint) =>
    prisma.production_order.findUniqueOrThrow({
      where: { production_order_id: orderId },
      select: { auto_work_order_attempted_at: true, auto_work_order_error_text: true },
    });

  it('정책 공장의 계획 없는 ERP W/O 를 배포까지 끌고 간다 — 취소·사람 계획·정책 없는 공장은 고르지 않는다', async () => {
    await runner.tick(start);

    const [plan] = await autoPlans(orders.ready);
    expect(plan.work_order.map((workOrder) => workOrder.status_code)).toEqual(['RELEASED']);
    expect(await attempt(orders.ready)).toEqual({ auto_work_order_attempted_at: start, auto_work_order_error_text: null });

    for (const key of ['cancelled', 'person', 'otherPlant']) {
      expect({ key, plans: await autoPlans(orders[key]), attempt: await attempt(orders[key]) }).toEqual({
        key, plans: [], attempt: { auto_work_order_attempted_at: null, auto_work_order_error_text: null },
      });
    }
  });

  it('실패하면 시도 시각·까닭을 남기고 10분 안에는 다시 고르지 않는다 — 10분 뒤 고쳐졌으면 처리하고 까닭을 지운다', async () => {
    expect(await attempt(orders.otherBom)).toEqual({
      auto_work_order_attempted_at: start, auto_work_order_error_text: expect.stringContaining('이 공장의 것이 아닙니다'),
    });

    await prisma.bom.update({ where: { bom_id: ids.otherBom }, data: { plant_id: ids.plant } });
    await runner.tick(new Date(start.getTime() + RETRY_AFTER_MS - 60_000));
    expect((await attempt(orders.otherBom)).auto_work_order_attempted_at).toEqual(start);
    expect(await autoPlans(orders.otherBom)).toEqual([]);

    const later = new Date(start.getTime() + RETRY_AFTER_MS + 60_000);
    await runner.tick(later);
    expect(await attempt(orders.otherBom)).toEqual({ auto_work_order_attempted_at: later, auto_work_order_error_text: null });
    const [plan] = await autoPlans(orders.otherBom);
    expect(plan.work_order.map((workOrder) => workOrder.status_code)).toEqual(['RELEASED']);
  });

  it('ERP 에서 취소되면 실적 없는 자동 W/O 를 취소하고 생산 LOT 을 폐번한다 — 실적이 있으면 그대로 두고 다시 고르지 않는다', async () => {
    const [kept] = (await autoPlans(orders.withResult))[0].work_order;
    const keptLot = await prisma.lot.findFirstOrThrow({ where: { source_type_code: 'WORK_ORDER', source_id: kept.work_order_id } });
    await prisma.$transaction((tx) => app.get(ProductionResultService).recordWithin(tx, {
      workOrderId: Number(kept.work_order_id), goodQty: 1, uomId: Number(ids.uom), lotId: keptLot.lot_id, occurredAt: start,
      resultSourceCode: 'TRACKING_SYSTEM', workerId: ids.worker, idempotencyKey: randomUUID(), productionResultNo: `${PREFIX}-PR`,
    }));
    const keptAttempt = await attempt(orders.withResult);
    await prisma.production_order.updateMany({
      where: { production_order_id: { in: [orders.erpCancel, orders.withResult] } }, data: { status_code: 'CANCELLED' },
    });
    const at = new Date(start.getTime() + 2 * RETRY_AFTER_MS);

    await runner.tick(at);

    const [cancelled] = (await autoPlans(orders.erpCancel))[0].work_order;
    expect(cancelled).toMatchObject({ status_code: 'CANCELLED', cancellation_reason_code: 'PLAN_CHANGE', updated_by: null });
    const lot = await prisma.lot.findFirstOrThrow({ where: { source_type_code: 'WORK_ORDER', source_id: cancelled.work_order_id } });
    expect(lot.lifecycle_status_code).toBe('VOIDED');
    expect(await attempt(orders.erpCancel)).toEqual({ auto_work_order_attempted_at: at, auto_work_order_error_text: null });
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: kept.work_order_id } })).status_code).toBe('RELEASED');
    expect(await attempt(orders.withResult)).toEqual(keptAttempt);
  });

  it('취소는 잠근 뒤 다시 본다 — 실적이 생긴 W/O 와 취소되지 않은 ERP W/O 의 W/O 는 건드리지 않는다', async () => {
    const auto = app.get(AutoWorkOrderService);
    await auto.cancelForErp(orders.withResult);
    await auto.cancelForErp(orders.ready);

    for (const key of ['withResult', 'ready']) {
      const [plan] = await autoPlans(orders[key]);
      expect({ key, statuses: plan.work_order.map((workOrder) => workOrder.status_code) }).toEqual({ key, statuses: ['RELEASED'] });
    }
  });

  async function order(key: string, opts: { plantId?: bigint; itemId?: bigint; status?: string } = {}): Promise<void> {
    orders[key] = (await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${++seq}`, business_unit_id: ids.unit, plant_id: opts.plantId ?? ids.plant,
      item_id: opts.itemId ?? ids.item, order_qty: 10, uom_id: ids.uom, status_code: opts.status ?? 'RECEIVED',
      erp_storage_location_code: SL_CD,
    } })).production_order_id;
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const plant = (suffix: string) => prisma.plant.create({ data: {
      plant_code: `${PREFIX}${suffix}`, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit,
      timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant = (await plant('P')).plant_id;
    const otherPlant = (await plant('Q')).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    await prisma.process.create({ data: { process_code: `${PREFIX}-ASSY`, process_name: '조립', process_type_code: 'ASSEMBLY' } });
    await prisma.operation_policy.create({ data: {
      policy_code: 'AUTO_ROUTING_PROCESS', plant_id: ids.plant, value_text: `${PREFIX}-ASSY`, effective_from: new Date('2026-01-01T00:00:00.000Z'),
    } });
    await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: SL_CD, warehouse_name: PREFIX,
      warehouse_type_code: 'PRODUCT', management_level_code: 'WAREHOUSE',
    } });

    const item = async (key: string, bomPlantId: bigint) => {
      const row = await prisma.item.create({ data: { item_code: `${PREFIX}-${key}`, item_name: PREFIX, item_type_code: 'FINISHED', base_uom_id: ids.uom } });
      const bom = await prisma.bom.create({ data: {
        parent_item_id: row.item_id, plant_id: bomPlantId, bom_code: `ERP-${PREFIX}-${key}`, bom_version: 1, status_code: 'CONFIRMED',
        is_default: true, effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
      } });
      return { itemId: row.item_id, bomId: bom.bom_id };
    };
    const good = await item('A', ids.plant);
    const bad = await item('B', otherPlant);
    const manual = await item('C', ids.plant);
    ids.item = good.itemId;
    ids.otherBom = bad.bomId;

    await order('ready');
    await order('cancelled', { status: 'CANCELLED' });
    await order('otherPlant', { plantId: otherPlant });
    await order('otherBom', { itemId: bad.itemId });
    await order('person', { itemId: manual.itemId });
    await order('erpCancel');
    await order('withResult');
    ids.worker = (await prisma.worker.create({ data: {
      worker_no: PREFIX, worker_name: PREFIX, plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED',
    } })).worker_id;
    const routing = await prisma.routing.create({ data: {
      item_id: manual.itemId, routing_code: `RT-${PREFIX}-C-01`, routing_version: 1, status_code: 'DRAFT',
    } });
    await prisma.production_plan.create({ data: {
      production_order_id: orders.person, plan_no: `${PREFIX}-PP`, plan_date: start, planned_qty: 4, uom_id: ids.uom,
      bom_id: manual.bomId, routing_id: routing.routing_id, status_code: 'DRAFT',
    } });
  }
});
