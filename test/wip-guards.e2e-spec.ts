/**
 * 피처 016 반제품 막기 — 공정 반제품(WIP) LOT 은 제품 입고·출하 피킹·생산 LOT 분리를 받지 않고(FR-004), 추적 시스템 자동 흐름은
 * 반제품 공정 W/O 의 제품 입고를 건너뛴다(R-9). 긴급 직행 출하는 `logistics-shipment.e2e-spec.ts`, 공정 인계 409 는
 * `production-operation-handover.e2e-spec.ts` 가 본다(omf-all-around#359).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StockMove, StockMoveService } from '../src/integration/tracking-system/stock-move.service';
import { SYSTEM_WORKER_NO } from '../src/integration/tracking-system/tracking-production';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductLotSplitFixture } from './support/product-lot-split-fixture';
import { ShipmentSimplifiedFixture } from './support/shipment-simplified-fixture';
import { WipLotFixture } from './support/wip-lot-fixture';

describe('반제품 막기 (피처 016, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('제품 입고', () => {
    let fx: WipLotFixture;
    let warehouseId: bigint;

    beforeAll(async () => {
      fx = new WipLotFixture(app, prisma, 'WIPGD', ['W-01-10']);
      await fx.setup();
      warehouseId = (await prisma.location.findUniqueOrThrow({ where: { location_id: fx.ids.location } })).warehouse_id;
    }, 120_000);

    const receipt = (lotId: bigint, itemId: bigint) => fx.http()
      .post('/api/logistics/goods-receipts')
      .set('Cookie', fx.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'PRODUCT', plantId: Number(fx.ids.plant), warehouseId: Number(warehouseId),
        receiptDatetime: '2026-11-25T04:00:00.000Z', businessDate: '2026-11-25',
        lines: [{
          itemId: Number(itemId), lotId: Number(lotId), receiptQty: 10, uomId: Number(fx.ids.uom),
          qualityStatusCode: 'NORMAL', inventoryStatusCode: 'AVAILABLE', destinationLocationId: Number(fx.ids.location),
        }],
      });

    it('US1-3·Q4·SC-002 — 반제품 LOT 의 제품 입고는 400 「반제품 LOT 은 제품 입고할 수 없습니다.」이고 원장이 없다', async () => {
      const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_10', 10, 10);
      await fx.result(workOrderId, lots[0].lot_id, 10, '2026-11-25T01:00:00.000Z').expect(201);

      const response = await receipt(lots[0].lot_id, fx.ids.itemAbc).expect(400);

      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'lines[0].lotId', code: 'INVALID', message: '반제품 LOT 은 제품 입고할 수 없습니다.' }),
      ]);
      expect(await prisma.goods_receipt_line.count({ where: { lot_id: lots[0].lot_id } })).toBe(0);
      expect(await prisma.inventory_balance.count({ where: { lot_id: lots[0].lot_id } })).toBe(0);
    });

    it('SC-005 — 마지막 공정의 PRODUCTION LOT 은 지금처럼 제품 입고된다', async () => {
      const { workOrderId, lots } = await fx.releasedWorkOrder('abc1_30', 10, 10);
      await fx.result(workOrderId, lots[0].lot_id, 10, '2026-11-25T01:00:00.000Z').expect(201);

      await receipt(lots[0].lot_id, fx.ids.itemAbc).expect(201);
    });
  });

  describe('출하 피킹', () => {
    let f: ShipmentSimplifiedFixture;

    beforeAll(async () => {
      f = new ShipmentSimplifiedFixture(app, prisma);
      await f.setup();
    }, 120_000);

    it('US1-3·Q4 — 반제품 LOT 피킹은 잔액이 있어도 409 SEMI_FINISHED_LOT 이고 예약이 없다', async () => {
      const made = await f.request([{ allocated: 100, inspection: false }]);
      const lot = await f.lot({ balances: [{ warehouse: 'wh1', qty: 50 }] });
      await prisma.lot.update({ where: { lot_id: BigInt(lot.lotId) }, data: { lot_type_code: 'WIP' } });

      const response = await f.pickLot(made, 0, { lotId: lot.lotId }).expect(409);

      expect(response.body).toMatchObject({ code: 'SEMI_FINISHED_LOT', message: '반제품 LOT 은 출하할 수 없습니다.' });
      expect(await prisma.inventory_reservation.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    });

    it('US1-3·Q4 — 잔액이 없는 반제품도 잔액 409 보다 반제품 409 가 먼저다', async () => {
      const made = await f.request([{ allocated: 100, inspection: false }]);
      const lot = await f.lot({ balances: [] });
      await prisma.lot.update({ where: { lot_id: BigInt(lot.lotId) }, data: { lot_type_code: 'WIP' } });

      const response = await f.pickLot(made, 0, { lotNo: lot.lotNo }).expect(409);

      expect(response.body.code).toBe('SEMI_FINISHED_LOT');
    });
  });

  describe('생산 LOT 분리', () => {
    let f: ProductLotSplitFixture;

    beforeAll(async () => {
      f = new ProductLotSplitFixture(app, prisma);
      await f.setup();
    }, 120_000);

    it('US1-3·Q4 — 스캔 조회는 blocked.code=SEMI_FINISHED_LOT, 분리 요청은 409 같은 코드다', async () => {
      const lot = await f.lot({ lotType: 'WIP', balances: [{ at: 'A', qty: 100 }] });

      const lookup = await f.lookup(lot.lotNo).expect(200);
      const split = await f.split({ lotId: lot.lotId, locationId: f.locationOf('A'), qty: 30 }).expect(409);

      expect(lookup.body.blocked).toMatchObject({ code: 'SEMI_FINISHED_LOT' });
      expect(split.body).toMatchObject({ code: 'SEMI_FINISHED_LOT', message: '반제품 LOT 은 분리할 수 없습니다.' });
      expect(await prisma.lot.count({ where: { parent_lot_id: BigInt(lot.lotId) } })).toBe(0);
    });
  });

  describe('추적 시스템 자동 흐름', () => {
    const PREFIX = `E2E_WIPTS_${randomUUID().slice(0, 8)}`;
    const OCCURRED = new Date('2026-11-25T03:00:00.000Z');
    const ids: Record<string, bigint> = {};
    let seq = 0;

    beforeAll(async () => {
      await trackingFixtures();
    }, 120_000);

    const move = (workOrderId: bigint, workOrderNo: string, qty: number): StockMove => ({
      transmissionId: randomUUID(), workOrderNo, mesWorkOrderId: Number(workOrderId), itemCode: PREFIX, qty,
      serialNos: Array.from({ length: qty }, () => `${PREFIX}-SN-${++seq}`),
      packedFrom: '2026-11-25T01:00:00.000Z', packedTo: '2026-11-25T03:00:00.000Z', businessDate: '2026-11-25',
    });

    it('Q18·R-9 — 반제품 공정(10) W/O 의 실적 전송은 실적·자재 차감만 하고 제품 입고 전표가 없다', async () => {
      const target = await trackedWorkOrder(ids.op10, 'WIP');

      await app.get(StockMoveService).receive(move(target.workOrderId, target.workOrderNo, 3), ids.plant);

      const result = await prisma.production_result.findFirstOrThrow({ where: { work_order_id: target.workOrderId } });
      expect(result.good_qty.toNumber()).toBe(3);
      expect(await prisma.goods_receipt.count({ where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id } })).toBe(0);
      expect(await prisma.inventory_balance.count({ where: { lot_id: target.lotId } })).toBe(0);
      expect(await prisma.goods_issue.count({ where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id } })).toBe(1);
      const documents = await prisma.tracking_transmission_document.findMany({ where: { tracking_transmission: { work_order_id: target.workOrderId } } });
      expect(documents.map((row) => row.document_type_code).sort()).toEqual(['GOODS_ISSUE', 'PRODUCTION_RESULT']);
    });

    it('Q18·SC-005 — 마지막 공정(20) W/O 는 지금처럼 제품 입고한다', async () => {
      const target = await trackedWorkOrder(ids.op20, 'PRODUCTION');

      await app.get(StockMoveService).receive(move(target.workOrderId, target.workOrderNo, 3), ids.plant);

      const result = await prisma.production_result.findFirstOrThrow({ where: { work_order_id: target.workOrderId } });
      expect(await prisma.goods_receipt.count({ where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id } })).toBe(1);
      expect((await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: target.lotId } })).on_hand_qty.toNumber()).toBe(3);
    });

    /** 자동 흐름의 배포 상태 W/O(지시 10)와 생산 LOT 하나 — 배포가 정한 유형(마지막 공정이 아니면 WIP)으로 둔다. */
    async function trackedWorkOrder(operationId: bigint, lotTypeCode: string): Promise<{ workOrderId: bigint; workOrderNo: string; lotId: bigint }> {
      const key = ++seq;
      const order = await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-PO-${key}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: ids.item,
        order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED',
      } });
      const plan = await prisma.production_plan.create({ data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: OCCURRED, planned_qty: 10,
        uom_id: ids.uom, bom_id: ids.bom, routing_id: ids.routing, status_code: 'CONFIRMED', confirmed_at: OCCURRED, created_automatically: true,
      } });
      const workOrder = await prisma.work_order.create({ data: {
        work_order_no: `${PREFIX}-WO-${key}`, production_plan_id: plan.production_plan_id, routing_operation_id: operationId,
        item_id: ids.item, order_qty: 10, uom_id: ids.uom, status_code: 'RELEASED', released_at: OCCURRED, default_fg_location_id: ids.location,
      } });
      const lot = await prisma.lot.create({ data: {
        lot_no: `${PREFIX}-LOT-${key}`, item_id: ids.item, lot_type_code: lotTypeCode, plant_id: ids.plant, initial_qty: 10,
        uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrder.work_order_id, status_code: 'INSPECTION_PENDING',
        lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
      } });
      return { workOrderId: workOrder.work_order_id, workOrderNo: workOrder.work_order_no, lotId: lot.lot_id };
    }

    async function trackingFixtures(): Promise<void> {
      const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
      ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
      ids.plant = (await prisma.plant.create({ data: {
        plant_code: `${PREFIX}-P`, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
      } })).plant_id;
      ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
      ids.item = (await prisma.item.create({ data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'FINISHED', base_uom_id: ids.uom } })).item_id;
      const material = (await prisma.item.create({ data: { item_code: `${PREFIX}-M`, item_name: '자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom } })).item_id;
      const process = await prisma.process.create({ data: { process_code: PREFIX, process_name: '가공', process_type_code: 'MACHINING' } });
      ids.routing = (await prisma.routing.create({ data: { item_id: ids.item, routing_code: `RT-${PREFIX}`, routing_version: 1, status_code: 'CONFIRMED' } })).routing_id;
      for (const [key, seqNo] of [['op10', 10], ['op20', 20]] as const) {
        ids[key] = (await prisma.routing_operation.create({ data: {
          routing_id: ids.routing, operation_seq: seqNo, process_id: process.process_id, operation_name: key,
        } })).routing_operation_id;
      }
      ids.bom = (await prisma.bom.create({ data: {
        parent_item_id: ids.item, plant_id: ids.plant, bom_code: `ERP-${PREFIX}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
        effective_from: OCCURRED, base_qty: 1, base_uom_id: ids.uom,
        bom_component: { create: [{ component_item_id: material, required_qty: 1, uom_id: ids.uom, sequence_no: 1 }] },
      } })).bom_id;
      const fg = await prisma.warehouse.create({ data: {
        plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-FG`, warehouse_name: '완제품', warehouse_type_code: 'FINISHED',
        management_level_code: 'LOCATION',
      } });
      ids.location = (await prisma.location.create({ data: {
        warehouse_id: fg.warehouse_id, location_code: `${PREFIX}-FG-L`, location_name: '완제품 입고', location_type_code: 'BIN',
      } })).location_id;
      const rm = await prisma.warehouse.create({ data: {
        plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-RM`, warehouse_name: '생산 자재', warehouse_type_code: 'MATERIAL',
        management_level_code: 'LOCATION',
      } });
      const shelf = await prisma.location.create({ data: {
        warehouse_id: rm.warehouse_id, location_code: `${PREFIX}-RM-S`, location_name: '선반', location_type_code: 'BIN',
      } });
      await prisma.operation_policy.create({ data: {
        policy_code: 'BACKFLUSH_WAREHOUSE', plant_id: ids.plant, value_text: `${PREFIX}-RM`, effective_from: new Date('2026-01-01'),
      } });
      const materialLot = await prisma.lot.create({ data: {
        lot_no: `${PREFIX}-ML`, item_id: material, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 100, uom_id: ids.uom,
        source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL', created_at: OCCURRED,
      } });
      await prisma.inventory_balance.create({ data: {
        legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, plant_id: ids.plant, warehouse_id: rm.warehouse_id,
        location_id: shelf.location_id, item_id: material, lot_id: materialLot.lot_id, quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: 100, uom_id: ids.uom,
      } });
      // 사번은 전역 유일이고 서버가 고정 사번으로 찾는다 — 이 DB 에 없으면 만든다.
      await prisma.worker.upsert({
        where: { worker_no: SYSTEM_WORKER_NO },
        create: { worker_no: SYSTEM_WORKER_NO, worker_name: 'flowtrack', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED' },
        update: { is_active: true },
      });
    }
  });
});
