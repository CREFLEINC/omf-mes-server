/**
 * 추적 시스템 연동 — 마감 보고 처리(flowtrack 연동 제안 §3-5 · §8 의 10-3).
 *
 * 한 트랜잭션에서 `qty` 만큼 실적 → 제품 입고 → 자재 차감 → 마감. S410 은 만든 수, 시리얼 품목은 0(양품은 입고이동으로 왔다).
 * 양품 합이 0 이면 마감 대신 취소하고, 취소 사유는 같은 코드가 없으면 「기타」다. 거절한 전송은 아무것도 남기지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StockMoveService } from '../src/integration/tracking-system/stock-move.service';
import { SYSTEM_WORKER_NO } from '../src/integration/tracking-system/tracking-production';
import { WorkOrderCloseReport, WorkOrderCloseReportService } from '../src/integration/tracking-system/work-order-close-report.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_TCR_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');

interface Case {
  workOrderId: bigint;
  workOrderNo: string;
  itemCode: string;
  lotId: bigint;
}

describe('추적 시스템 연동 — 마감 보고 처리 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reports: WorkOrderCloseReportService;
  let moves: StockMoveService;
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    reports = app.get(WorkOrderCloseReportService);
    moves = app.get(StockMoveService);
    await fixtures();
  });

  afterAll(async () => {
    await app.close();
  });

  const report = (target: Case, qty: number, patch: Partial<WorkOrderCloseReport> = {}): WorkOrderCloseReport => ({
    transmissionId: randomUUID(), workOrderNo: target.workOrderNo, mesWorkOrderId: Number(target.workOrderId), itemCode: target.itemCode,
    qty, businessDate: '2026-11-16', ...patch,
  });
  const workOrder = (target: Case) => prisma.work_order.findUniqueOrThrow({ where: { work_order_id: target.workOrderId } });

  it('S410 — 만든 수만큼 실적·제품 입고·자재 차감 뒤 마감한다 · 같은 전송은 다시 처리하지 않는다', async () => {
    const target = await released('fru');
    const input = report(target, 10);

    expect(await reports.receive(input, ids.plant)).toEqual({ replayed: false });

    const result = await prisma.production_result.findFirstOrThrow({ where: { work_order_id: target.workOrderId } });
    expect(result).toMatchObject({ result_source_code: 'TRACKING_SYSTEM', worker_id: ids.worker });
    expect(result.good_qty.toNumber()).toBe(10);
    expect((await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: target.lotId, location_id: ids.location } })).on_hand_qty.toNumber()).toBe(10);
    expect((await prisma.inventory_balance.findUniqueOrThrow({ where: { inventory_balance_id: ids.materialBalance } })).on_hand_qty.toNumber()).toBe(90);
    expect(await workOrder(target)).toMatchObject({ status_code: 'CLOSED', close_judgment_code: 'NORMAL', closed_worker_id: ids.worker });
    const transmission = await prisma.tracking_transmission.findUniqueOrThrow({
      where: { transmission_id: input.transmissionId }, include: { tracking_transmission_document: { orderBy: { document_type_code: 'asc' } } },
    });
    expect(transmission.kind_code).toBe('WORK_ORDER_CLOSE');
    expect(transmission.tracking_transmission_document.map((doc) => doc.document_type_code)).toEqual(['GOODS_ISSUE', 'GOODS_RECEIPT', 'PRODUCTION_RESULT']);

    expect(await reports.receive(input, ids.plant)).toEqual({ replayed: true });
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(1);
  });

  it('S410 — 적게 만들고 끝내면 처분·사유·비고와 함께 미달 마감한다', async () => {
    const target = await released('fru');

    await reports.receive(report(target, 6, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'PLAN_CHANGE', remarks: 'flowtrack 마감: 관리자' }), ids.plant);

    expect(await workOrder(target)).toMatchObject({
      status_code: 'CLOSED', close_judgment_code: 'UNDER', close_disposition_code: 'WRITE_OFF', completion_variance_reason_code: 'PLAN_CHANGE',
      remarks: 'flowtrack 마감: 관리자', closed_worker_id: ids.worker,
    });
  });

  it('시리얼 품목 — 입고이동으로 받은 양품으로 qty 0 조기 마감한다', async () => {
    const target = await released('serial');
    await pack(target, 3);

    await reports.receive(report(target, 0, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'EQUIPMENT_FAILURE', remarks: null }), ids.plant);

    expect(await workOrder(target)).toMatchObject({ status_code: 'CLOSED', close_judgment_code: 'UNDER', completion_variance_reason_code: 'EQUIPMENT_FAILURE' });
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(1);
  });

  it.each([['PLAN_CHANGE', 'PLAN_CHANGE'], ['QUALITY_DEFECT', 'OTHER']])(
    '양품 없이 끝내면 마감하지 않고 취소한다 · 생산 LOT 폐번 — 마감 사유 %s → 취소 사유 %s',
    async (reasonCode, cancellation) => {
      const target = await released('serial');

      await reports.receive(report(target, 0, { remainderDispositionCode: 'WRITE_OFF', reasonCode }), ids.plant);

      expect(await workOrder(target)).toMatchObject({ status_code: 'CANCELLED', cancellation_reason_code: cancellation, closed_at: null });
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: target.lotId } })).lifecycle_status_code).toBe('VOIDED');
    },
  );

  const rejections: [string, string, () => Promise<{ target: Case; input: WorkOrderCloseReport }>][] = [
    ['모르는 W/O', 'INVALID', async () => {
      const target = await released('fru');
      return { target, input: report(target, 10, { mesWorkOrderId: 2 ** 40 }) };
    }],
    ['품목이 W/O 와 다름', 'INVALID', async () => {
      const target = await released('fru');
      return { target, input: report(target, 10, { itemCode: `${PREFIX}-serial` }) };
    }],
    ['마감된 W/O', 'STATE_LOCKED', async () => {
      const target = await released('fru');
      await prisma.work_order.update({ where: { work_order_id: target.workOrderId }, data: { status_code: 'CLOSED', closed_at: OCCURRED } });
      return { target, input: report(target, 0) };
    }],
    ['양품 합이 지시수량을 넘음', 'RANGE', async () => {
      const target = await released('fru');
      return { target, input: report(target, 11) };
    }],
    ['미달인데 처분이 없음', 'REMAINDER_DISPOSITION_REQUIRED', async () => {
      const target = await released('fru');
      return { target, input: report(target, 6, { reasonCode: 'PLAN_CHANGE' }) };
    }],
    ['쓰지 않는 사유', 'INVALID', async () => {
      const target = await released('fru');
      return { target, input: report(target, 6, { remainderDispositionCode: 'WRITE_OFF', reasonCode: `${PREFIX}-NONE` }) };
    }],
    ['시리얼 품목인데 qty 가 있음', 'INVALID', async () => {
      const target = await released('serial');
      await pack(target, 1);
      return { target, input: report(target, 2, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'PLAN_CHANGE' }) };
    }],
    ['양품 없이 끝내는데 사유가 없음', 'REQUIRED', async () => {
      const target = await released('serial');
      return { target, input: report(target, 0, { remainderDispositionCode: 'WRITE_OFF' }) };
    }],
    ['양품 없이 끝내는데 쓰지 않는 사유', 'INVALID', async () => {
      const target = await released('serial');
      return { target, input: report(target, 0, { remainderDispositionCode: 'WRITE_OFF', reasonCode: `${PREFIX}-NONE` }) };
    }],
  ];

  it.each(rejections)('거절하면 아무것도 남기지 않는다 — %s', async (_name, code, arrange) => {
    const { target, input } = await arrange();
    const before = await workOrder(target);
    const results = await prisma.production_result.count({ where: { work_order_id: target.workOrderId } });

    await expect(reports.receive(input, ids.plant)).rejects.toMatchObject({ errors: [expect.objectContaining({ code })] });

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
    expect((await workOrder(target)).status_code).toBe(before.status_code);
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(results);
  });

  async function pack(target: Case, count: number): Promise<void> {
    await moves.receive({
      transmissionId: randomUUID(), workOrderNo: target.workOrderNo, mesWorkOrderId: Number(target.workOrderId), itemCode: target.itemCode,
      qty: count, serialNos: Array.from({ length: count }, (_, index) => `${PREFIX}-SN-${++seq}-${index}`),
      packedFrom: '2026-11-16T01:00:00.000Z', packedTo: '2026-11-16T03:00:00.000Z', businessDate: '2026-11-16',
    }, ids.plant);
  }

  /** 자동 계획 W/O(지시수량 10)와 그 생산 LOT 하나 — `fru` 는 시리얼 없는 S410 품목(자재 하나 · 1개당 1), `serial` 은 시리얼 품목. */
  async function released(kind: 'fru' | 'serial'): Promise<Case> {
    const key = ++seq;
    const itemId = kind === 'fru' ? ids.fru : ids.serial;
    const itemCode = kind === 'fru' ? `${PREFIX}-fru` : `${PREFIX}-serial`;
    const order = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${key}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: itemId,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    const plan = await prisma.production_plan.create({ data: {
      production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: OCCURRED, planned_qty: 10,
      uom_id: ids.uom, bom_id: kind === 'fru' ? ids.fruBom : ids.serialBom, routing_id: ids.routing, status_code: 'CONFIRMED',
      confirmed_at: OCCURRED, created_automatically: true,
    } });
    const row = await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, production_plan_id: plan.production_plan_id, routing_operation_id: ids.operation,
      item_id: itemId, order_qty: 10, uom_id: ids.uom, status_code: 'RELEASED', released_at: OCCURRED, default_fg_location_id: ids.location,
    } });
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${key}`, item_id: itemId, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 10,
      uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: row.work_order_id, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
    } });
    return { workOrderId: row.work_order_id, workOrderNo: row.work_order_no, itemCode, lotId: lot.lot_id };
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    ids.plant = (await prisma.plant.create({ data: {
      plant_code: `${PREFIX}-plant`, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    for (const [key, type] of [['fru', 'FINISHED'], ['serial', 'FINISHED'], ['material', 'RAW_MATERIAL']]) {
      ids[key] = (await prisma.item.create({ data: { item_code: `${PREFIX}-${key}`, item_name: key, item_type_code: type, base_uom_id: ids.uom } })).item_id;
    }
    const process = await prisma.process.create({ data: { process_code: PREFIX, process_name: '조립', process_type_code: 'ASSEMBLY' } });
    ids.routing = (await prisma.routing.create({ data: {
      item_id: ids.fru, routing_code: `RT-${PREFIX}`, routing_version: 1, status_code: 'CONFIRMED',
    } })).routing_id;
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: ids.routing, operation_seq: 10, process_id: process.process_id, operation_name: '조립',
    } })).routing_operation_id;
    for (const [key, itemKey] of [['fruBom', 'fru'], ['serialBom', 'serial']]) {
      ids[key] = (await prisma.bom.create({ data: {
        parent_item_id: ids[itemKey], plant_id: ids.plant, bom_code: `ERP-${PREFIX}-${key}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
        effective_from: OCCURRED, base_qty: 1, base_uom_id: ids.uom,
        ...(key === 'fruBom' ? { bom_component: { create: [{ component_item_id: ids.material, required_qty: 1, uom_id: ids.uom, sequence_no: 1 }] } } : {}),
      } })).bom_id;
    }
    for (const [key, code, type] of [['warehouse', 'S410', 'FINISHED'], ['rm', 'RM', 'MATERIAL']]) {
      ids[key] = (await prisma.warehouse.create({ data: {
        plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-${code}`, warehouse_name: code, warehouse_type_code: type,
        management_level_code: 'LOCATION',
      } })).warehouse_id;
    }
    for (const [key, warehouseKey] of [['location', 'warehouse'], ['rmLocation', 'rm']]) {
      ids[key] = (await prisma.location.create({ data: {
        warehouse_id: ids[warehouseKey], location_code: `${PREFIX}-${key}`, location_name: key, location_type_code: 'BIN',
      } })).location_id;
    }
    await prisma.operation_policy.create({ data: {
      policy_code: 'BACKFLUSH_WAREHOUSE', plant_id: ids.plant, value_text: `${PREFIX}-RM`, effective_from: new Date('2026-01-01'),
    } });
    const materialLot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-ML`, item_id: ids.material, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 100, uom_id: ids.uom,
      source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
    } });
    ids.materialBalance = (await prisma.inventory_balance.create({ data: {
      legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, plant_id: ids.plant, warehouse_id: ids.rm, location_id: ids.rmLocation,
      item_id: ids.material, lot_id: materialLot.lot_id, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
      ownership_type_code: 'OWNED', on_hand_qty: 100, uom_id: ids.uom,
    } })).inventory_balance_id;
    // 사번은 전역 유일이고 서버가 고정 사번으로 찾는다 — 이 DB 에 없으면 만든다.
    ids.worker = (await prisma.worker.upsert({
      where: { worker_no: SYSTEM_WORKER_NO },
      create: { worker_no: SYSTEM_WORKER_NO, worker_name: 'flowtrack', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED' },
      update: { is_active: true },
    })).worker_id;
  }
});
