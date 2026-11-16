/**
 * 추적 시스템 연동 — 포장 입고이동 처리(flowtrack 연동 제안 §3-3 · §8 의 7-2).
 *
 * 한 트랜잭션에서 실적 → 시리얼 → 제품 입고 → (양품 합이 지시수량이면) 마감. 처리한 전송 번호는 다시 처리하지 않고,
 * 거절한 전송은 아무것도 남기지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StockMove, StockMoveService, SYSTEM_WORKER_NO } from '../src/integration/tracking-system/stock-move.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_TSM_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');

interface Case {
  workOrderId: bigint;
  workOrderNo: string;
  lotId: bigint;
}

describe('추적 시스템 연동 — 포장 입고이동 처리 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moves: StockMoveService;
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    moves = app.get(StockMoveService);
    await fixtures();
  });

  afterAll(async () => {
    await app.close();
  });

  const serials = (count: number) => Array.from({ length: count }, () => `${PREFIX}-SN-${++seq}`);
  const body = (target: Case, serialNos: string[], patch: Partial<StockMove> = {}): StockMove => ({
    transmissionId: randomUUID(), workOrderNo: target.workOrderNo, mesWorkOrderId: Number(target.workOrderId), itemCode: PREFIX,
    qty: serialNos.length, serialNos, packedFrom: '2026-11-16T01:00:00.000Z', packedTo: '2026-11-16T03:00:00.000Z', businessDate: '2026-11-16',
    ...patch,
  });

  it('포장 한 묶음 — 시스템 작업자 실적 · 시리얼 · 완제품 위치에 정상·가용 입고(적치 지시 없음) · 전송과 만든 문서를 남긴다', async () => {
    const target = await releasedWorkOrder();
    const input = body(target, serials(4), { mesWorkOrderId: null });
    expect(await moves.receive(input, ids.plant)).toEqual({ replayed: false });

    const result = await prisma.production_result.findFirstOrThrow({ where: { work_order_id: target.workOrderId } });
    expect(result).toMatchObject({ result_source_code: 'TRACKING_SYSTEM', worker_id: ids.worker, occurred_at: OCCURRED });
    expect(result.good_qty.toNumber()).toBe(4);
    expect(await prisma.serial_number.count({ where: { serial_no: { in: input.serialNos }, lot_id: target.lotId, item_id: ids.item } })).toBe(4);
    const receipt = await prisma.goods_receipt.findFirstOrThrow({
      where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id },
      include: { goods_receipt_line: true },
    });
    expect(receipt).toMatchObject({ receipt_type_code: 'PRODUCT', plant_id: ids.plant, warehouse_id: ids.warehouse, created_by: null });
    expect(receipt.goods_receipt_line).toEqual([expect.objectContaining({
      lot_id: target.lotId, destination_location_id: ids.location, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
    })]);
    expect(await prisma.putaway_task.count({ where: { goods_receipt_line_id: receipt.goods_receipt_line[0].goods_receipt_line_id } })).toBe(0);
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { location_id: ids.location, lot_id: target.lotId } });
    expect(balance).toMatchObject({ quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE' });
    expect(balance.on_hand_qty.toNumber()).toBe(4);

    const transmission = await prisma.tracking_transmission.findUniqueOrThrow({
      where: { transmission_id: input.transmissionId },
      include: { tracking_transmission_document: { orderBy: { document_type_code: 'asc' } } },
    });
    expect(transmission).toMatchObject({ kind_code: 'STOCK_MOVE', plant_id: ids.plant, work_order_id: target.workOrderId, payload: input });
    expect(transmission.tracking_transmission_document).toEqual([
      expect.objectContaining({ document_type_code: 'GOODS_RECEIPT', document_id: receipt.goods_receipt_id }),
      expect.objectContaining({ document_type_code: 'PRODUCTION_RESULT', document_id: result.production_result_id }),
    ]);
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: target.workOrderId } })).status_code).toBe('RELEASED');
  });

  it('양품 합이 지시수량에 닿으면 마감한다 · 같은 전송 번호가 다시 오면 아무것도 하지 않는다', async () => {
    const target = await releasedWorkOrder();
    await moves.receive(body(target, serials(6)), ids.plant);
    const last = body(target, serials(4));
    expect(await moves.receive(last, ids.plant)).toEqual({ replayed: false });
    expect(await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: target.workOrderId } })).toMatchObject({
      status_code: 'CLOSED', closed_worker_id: ids.worker, close_judgment_code: 'NORMAL',
    });

    expect(await moves.receive(last, ids.plant)).toEqual({ replayed: true });
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(2);
    expect(await prisma.tracking_transmission.count({ where: { work_order_id: target.workOrderId } })).toBe(2);
  });

  const rejections: [string, string, (target: Case) => Promise<{ input: StockMove; plantId?: bigint; restore?: () => Promise<unknown> }>][] = [
    ['모르는 W/O', 'INVALID', async (target) => ({ input: body(target, serials(1), { mesWorkOrderId: 2 ** 40 }) })],
    ['다른 공장의 W/O', 'INVALID', async (target) => ({ input: body(target, serials(1)), plantId: ids.otherPlant })],
    ['품목이 W/O 와 다름', 'INVALID', async (target) => ({ input: body(target, serials(1), { itemCode: `${PREFIX}-X` }) })],
    ['수량이 시리얼 수와 다름', 'INVALID', async (target) => ({ input: body(target, serials(2), { qty: 3 }) })],
    ['본문 안에서 겹친 시리얼', 'INVALID', async (target) => {
      const [serialNo] = serials(1);
      return { input: body(target, [serialNo, serialNo]) };
    }],
    ['MES 에 이미 있는 시리얼', 'UNIQUE_VIOLATION', async (target) => {
      const taken = await prisma.serial_number.create({ data: { serial_no: `${PREFIX}-SN-${++seq}`, item_id: ids.item, lot_id: ids.otherLot, status_code: 'REGISTERED' } });
      return { input: body(target, [...serials(1), taken.serial_no]) };
    }],
    ['양품 합이 지시수량을 넘음', 'RANGE', async (target) => ({ input: body(target, serials(11)) })],
    ['마감된 W/O', 'STATE_LOCKED', async (target) => {
      await prisma.work_order.update({ where: { work_order_id: target.workOrderId }, data: { status_code: 'CLOSED', closed_at: OCCURRED } });
      return { input: body(target, serials(1)) };
    }],
    ['시스템 작업자가 꺼짐', 'INVALID', async (target) => {
      await prisma.worker.update({ where: { worker_id: ids.worker }, data: { is_active: false } });
      return { input: body(target, serials(1)), restore: () => prisma.worker.update({ where: { worker_id: ids.worker }, data: { is_active: true } }) };
    }],
    ['실적 뒤에도 생산 LOT 이 정상이 아님(MES 보류)', 'STATE_LOCKED', async (target) => {
      await prisma.lot_hold.create({ data: { lot_id: target.lotId, reason_code: 'SUSPECT', status_code: 'HELD', held_at: OCCURRED, held_worker_id: ids.worker } });
      return { input: body(target, serials(1)) };
    }],
  ];

  it.each(rejections)('거절하면 아무것도 남기지 않는다 — %s', async (_name, code, arrange) => {
    const target = await releasedWorkOrder();
    const { input, plantId, restore } = await arrange(target);
    try {
      await expect(moves.receive(input, plantId ?? ids.plant)).rejects.toMatchObject({ errors: [expect.objectContaining({ code })] });
    } finally {
      await restore?.();
    }
    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(0);
    expect(await prisma.serial_number.count({ where: { lot_id: target.lotId } })).toBe(0);
  });

  /** 자동 흐름이 세운 계획의 배포 상태 W/O(지시수량 10)와 그 생산 LOT 하나. */
  async function releasedWorkOrder(): Promise<Case> {
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
      work_order_no: `${PREFIX}-WO-${key}`, production_plan_id: plan.production_plan_id, routing_operation_id: ids.operation,
      item_id: ids.item, order_qty: 10, uom_id: ids.uom, status_code: 'RELEASED', released_at: OCCURRED, default_fg_location_id: ids.location,
    } });
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${key}`, item_id: ids.item, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 10,
      uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrder.work_order_id, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
    } });
    return { workOrderId: workOrder.work_order_id, workOrderNo: workOrder.work_order_no, lotId: lot.lot_id };
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    for (const key of ['plant', 'otherPlant']) {
      ids[key] = (await prisma.plant.create({ data: {
        plant_code: `${PREFIX}-${key}`, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
      } })).plant_id;
    }
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    ids.item = (await prisma.item.create({ data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'FINISHED', base_uom_id: ids.uom } })).item_id;
    const process = await prisma.process.create({ data: { process_code: PREFIX, process_name: '조립', process_type_code: 'ASSEMBLY' } });
    ids.routing = (await prisma.routing.create({ data: {
      item_id: ids.item, routing_code: `RT-${PREFIX}`, routing_version: 1, status_code: 'CONFIRMED',
    } })).routing_id;
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: ids.routing, operation_seq: 10, process_id: process.process_id, operation_name: '조립',
    } })).routing_operation_id;
    ids.bom = (await prisma.bom.create({ data: {
      parent_item_id: ids.item, plant_id: ids.plant, bom_code: `ERP-${PREFIX}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
      effective_from: OCCURRED, base_qty: 1, base_uom_id: ids.uom,
    } })).bom_id;
    ids.warehouse = (await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-FG`, warehouse_name: '완제품', warehouse_type_code: 'FINISHED',
      management_level_code: 'LOCATION',
    } })).warehouse_id;
    ids.location = (await prisma.location.create({ data: {
      warehouse_id: ids.warehouse, location_code: `${PREFIX}-FG-L`, location_name: '완제품 입고', location_type_code: 'BIN',
    } })).location_id;
    // 사번은 전역 유일이고 서버가 고정 사번으로 찾는다 — 이 DB 에 없으면 만든다.
    ids.worker = (await prisma.worker.upsert({
      where: { worker_no: SYSTEM_WORKER_NO },
      create: { worker_no: SYSTEM_WORKER_NO, worker_name: 'flowtrack', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED' },
      update: { is_active: true },
    })).worker_id;
    ids.otherLot = (await releasedWorkOrder()).lotId;
  }
});
