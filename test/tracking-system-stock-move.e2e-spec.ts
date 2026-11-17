/**
 * 추적 시스템 연동 — 포장 입고이동 처리(flowtrack 연동 제안 §3-3 · §8 의 7-2).
 *
 * 한 트랜잭션에서 실적 → 시리얼 → 제품 입고 → 자재 차감(8) → (양품 합이 지시수량이면) 마감. 처리한 전송 번호는 다시 처리하지 않고,
 * 거절한 전송은 아무것도 남기지 않는다. HTTP 입구(7-3)는 연동 단말 토큰만 받는다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { StockMove, StockMoveService, SYSTEM_WORKER_NO } from '../src/integration/tracking-system/stock-move.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_TSM_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');
const POLICY_FROM = new Date('2026-01-01');

interface Case {
  workOrderId: bigint;
  workOrderNo: string;
  lotId: bigint;
}

interface Stock {
  lotId: bigint | null;
  balanceId: bigint;
}

describe('추적 시스템 연동 — 포장 입고이동 처리 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moves: StockMoveService;
  let seq = 0;
  const ids: Record<string, bigint> = {};
  const callers: Record<string, [string, string]> = {};

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
    ['자재 차감 창고 정책이 없음', 'INVALID', async (target) => {
      const policy = { where: { operation_policy_id: ids.policy } };
      await prisma.operation_policy.update({ ...policy, data: { effective_from: new Date('2099-01-01') } });
      return { input: body(target, serials(1)), restore: () => prisma.operation_policy.update({ ...policy, data: { effective_from: POLICY_FROM } }) };
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

  it('자재 차감 — 하위 BOM 까지 풀어(소요량 0 은 건너뜀 · 소수 6자리) 맨 아래 위치에서 오래된 LOT 부터 출고 전표 하나로 · 투입 기록과 계보 · 같은 전송은 다시 빼지 않는다', async () => {
    const [plain, kitPart, fraction, unused, kit] = await materials('plain', 'kitPart', 'fraction', 'unused', 'kit');
    await bom(kit, [[kitPart, 1]], { isDefault: true, baseQty: 3 });
    const target = await releasedWorkOrder(await bom(ids.item, [[plain, 2], [kit, 1], [fraction, 0.033333], [unused, 0]]));
    const older = await stock(plain, 5, { lotCreatedAt: new Date('2026-11-01T00:00:00.000Z') });
    const newer = await stock(plain, 10);
    const part = await stock(kitPart, 1.333333);
    const box = await stock(fraction, 1);
    const input = body(target, serials(4));

    await moves.receive(input, ids.plant);

    const result = await prisma.production_result.findFirstOrThrow({ where: { work_order_id: target.workOrderId } });
    const issue = await prisma.goods_issue.findFirstOrThrow({
      where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id },
      include: { goods_issue_line: { orderBy: { line_no: 'asc' } } },
    });
    expect(issue).toMatchObject({ issue_type_code: 'PRODUCTION', source_warehouse_id: ids.rm, status_code: 'POSTED', destination_type_code: null });
    const taken = [[older, 5], [newer, 3], [box, 0.133332], [part, 1.333333]] as const;
    expect(issue.goods_issue_line.map((line) => [line.lot_id, line.issue_qty.toNumber()])).toEqual(taken.map(([from, qty]) => [from.lotId, qty]));
    expect(await onHand(older, newer, box, part)).toEqual([0, 7, 0.866668, 0]);
    const consumptions = await prisma.material_consumption.findMany({ where: { work_order_id: target.workOrderId }, orderBy: { consumption_no: 'asc' } });
    expect(consumptions.map((row) => [row.lot_id, row.input_qty.toNumber(), row.consumption_type_code, row.worker_id])).toEqual(
      taken.map(([from, qty]) => [from.lotId, qty, 'BACKFLUSH', ids.worker]),
    );
    const genealogy = await prisma.lot_relation.findMany({ where: { target_lot_id: target.lotId }, select: { source_lot_id: true } });
    expect(new Set(genealogy.map((row) => row.source_lot_id))).toEqual(new Set(taken.map(([from]) => from.lotId)));
    expect(await prisma.tracking_transmission_document.count({ where: { document_type_code: 'GOODS_ISSUE', document_id: issue.goods_issue_id } })).toBe(1);
    expect(await shortagesOf(input)).toEqual([]);

    expect(await moves.receive(input, ids.plant)).toEqual({ replayed: true });
    expect(await prisma.goods_issue.count({ where: { source_document_type_code: 'PRODUCTION_RESULT', source_document_id: result.production_result_id } })).toBe(1);
    expect(await onHand(older, newer, box, part)).toEqual([0, 7, 0.866668, 0]);
  });

  it('자재 차감 — 모자란 몫은 미차감으로 남기고 제품 입고는 그대로 한다', async () => {
    const [short, missing] = await materials('short', 'missing');
    const target = await releasedWorkOrder(await bom(ids.item, [[short, 1], [missing, 0.5]]));
    const some = await stock(short, 1);
    const input = body(target, serials(3));

    expect(await moves.receive(input, ids.plant)).toEqual({ replayed: false });

    expect(await shortagesOf(input)).toEqual([[short, ids.uom, ids.rm, 2], [missing, ids.uom, ids.rm, 1.5]]);
    expect(await onHand(some)).toEqual([0]);
    expect((await prisma.inventory_balance.findFirstOrThrow({ where: { location_id: ids.location, lot_id: target.lotId } })).on_hand_qty.toNumber()).toBe(3);
  });

  it('자재 차감 — 뺄 수 없는 재고(보류·LOT 불량·품질 불량·아래 위치가 있는 위치·다른 창고·LOT 없음·한 LOT 이 두 상태)는 건드리지 않는다', async () => {
    const [item] = await materials('blocked');
    const target = await releasedWorkOrder(await bom(ids.item, [[item, 1]]));
    const held = await stock(item, 5);
    await prisma.lot_hold.create({ data: { lot_id: held.lotId as bigint, reason_code: 'SUSPECT', status_code: 'HELD', held_at: OCCURRED, held_worker_id: ids.worker } });
    const split = await stock(item, 5);
    const untouched = [
      held, split,
      await stock(item, 5, { lotId: split.lotId as bigint, quality: 'DEFECTIVE' }),
      await stock(item, 5, { lotStatus: 'DEFECTIVE' }),
      await stock(item, 5, { quality: 'DEFECTIVE' }),
      await stock(item, 5, { locationId: ids.zone }),
      await stock(item, 5, { warehouseId: ids.warehouse, locationId: ids.location }),
      await stock(item, 5, { withoutLot: true }),
    ];
    const input = body(target, serials(2));

    await moves.receive(input, ids.plant);

    expect(await onHand(...untouched)).toEqual(untouched.map(() => 5));
    expect(await shortagesOf(input)).toEqual([[item, ids.uom, ids.rm, 2]]);
    expect(await prisma.tracking_transmission_document.count({
      where: { document_type_code: 'GOODS_ISSUE', tracking_transmission: { transmission_id: input.transmissionId } },
    })).toBe(0);
  });

  const post = (input: StockMove, caller: [string, string], key = input.transmissionId) => request(app.getHttpServer())
    .post('/api/integration/tracking-system/stock-moves').set(...caller).set('Idempotency-Key', key).send(input);

  it('HTTP — 연동 토큰으로 보내면 받고, 같은 전송을 다시 보내면 200 에 replayed 로 답한다', async () => {
    const target = await releasedWorkOrder();
    const input = body(target, serials(3));

    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: false });
    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: true });
    expect(await prisma.production_result.count({ where: { work_order_id: target.workOrderId } })).toBe(1);
  });

  it('HTTP — 헤더 요청 키와 전송 번호가 다르면 400 이고 아무것도 남기지 않는다', async () => {
    const target = await releasedWorkOrder();
    const input = body(target, serials(1));

    const response = await post(input, callers.tracking, randomUUID()).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'transmissionId', code: 'INVALID' })]);
    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
  });

  it.each(['web', 'pop'])('HTTP — 연동 토큰이 아니면(%s) 401 이고 아무것도 남기지 않는다', async (caller) => {
    const target = await releasedWorkOrder();
    const input = body(target, serials(1));

    await post(input, callers[caller]).expect(401);

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
  });

  async function materials(...names: string[]): Promise<bigint[]> {
    const created: bigint[] = [];
    for (const name of names) {
      created.push((await prisma.item.create({ data: {
        item_code: `${PREFIX}-${name}-${++seq}`, item_name: name, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom,
      } })).item_id);
    }
    return created;
  }

  /** 기본 BOM 은 이 공장의 것이라 그 품목이 구성품이면 다시 풀린다. */
  async function bom(parentItemId: bigint, components: [bigint, number][], { isDefault = false, baseQty = 1 } = {}): Promise<bigint> {
    return (await prisma.bom.create({ data: {
      parent_item_id: parentItemId, plant_id: ids.plant, bom_code: `${PREFIX}-BOM-${++seq}`, bom_version: 1, status_code: 'CONFIRMED',
      is_default: isDefault, effective_from: OCCURRED, base_qty: baseQty, base_uom_id: ids.uom,
      bom_component: { create: components.map(([itemId, qty], index) => ({
        component_item_id: itemId, required_qty: qty, uom_id: ids.uom, sequence_no: index + 1,
      })) },
    } })).bom_id;
  }

  /** 차감 창고 선반의 정상·가용 재고 — 고친 칸만 다르다. */
  async function stock(itemId: bigint, qty: number, patch: {
    lotCreatedAt?: Date; lotStatus?: string; lotId?: bigint; withoutLot?: boolean; quality?: string; warehouseId?: bigint; locationId?: bigint;
  } = {}): Promise<Stock> {
    const lotId = patch.withoutLot === true ? null : patch.lotId ?? (await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-ML-${++seq}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.uom,
      source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: patch.lotStatus ?? 'NORMAL', created_at: patch.lotCreatedAt ?? OCCURRED,
    } })).lot_id;
    const balance = await prisma.inventory_balance.create({ data: {
      legal_entity_id: ids.entity, business_unit_id: ids.unit, plant_id: ids.plant, warehouse_id: patch.warehouseId ?? ids.rm,
      location_id: patch.locationId ?? ids.shelf, item_id: itemId, lot_id: lotId, quality_status_code: patch.quality ?? 'NORMAL',
      inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: qty, uom_id: ids.uom,
    } });
    return { lotId, balanceId: balance.inventory_balance_id };
  }

  async function onHand(...stocks: Stock[]): Promise<number[]> {
    const rows = await prisma.inventory_balance.findMany({ where: { inventory_balance_id: { in: stocks.map((row) => row.balanceId) } } });
    return stocks.map((row) => (rows.find((found) => found.inventory_balance_id === row.balanceId) as (typeof rows)[number]).on_hand_qty.toNumber());
  }

  async function shortagesOf(input: StockMove): Promise<[bigint, bigint, bigint, number][]> {
    const rows = await prisma.tracking_transmission_shortage.findMany({
      where: { tracking_transmission: { transmission_id: input.transmissionId } }, orderBy: { item_id: 'asc' },
    });
    return rows.map((row) => [row.item_id, row.uom_id, row.warehouse_id, row.shortage_qty.toNumber()]);
  }

  /** 자동 흐름이 세운 계획의 배포 상태 W/O(지시수량 10)와 그 생산 LOT 하나. */
  async function releasedWorkOrder(bomId = ids.bom): Promise<Case> {
    const key = ++seq;
    const order = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${key}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: ids.item,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    const plan = await prisma.production_plan.create({ data: {
      production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: OCCURRED, planned_qty: 10,
      uom_id: ids.uom, bom_id: bomId, routing_id: ids.routing, status_code: 'CONFIRMED', confirmed_at: OCCURRED, created_automatically: true,
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
    ids.entity = base.legal_entity_id;
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
    ids.rm = (await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-RM`, warehouse_name: '생산 자재', warehouse_type_code: 'MATERIAL',
      management_level_code: 'LOCATION',
    } })).warehouse_id;
    ids.zone = (await prisma.location.create({ data: {
      warehouse_id: ids.rm, location_code: `${PREFIX}-RM-Z`, location_name: '구역', location_type_code: 'ZONE',
    } })).location_id;
    ids.shelf = (await prisma.location.create({ data: {
      warehouse_id: ids.rm, parent_location_id: ids.zone, location_code: `${PREFIX}-RM-S`, location_name: '선반', location_type_code: 'BIN',
    } })).location_id;
    ids.policy = (await prisma.operation_policy.create({ data: {
      policy_code: 'BACKFLUSH_WAREHOUSE', plant_id: ids.plant, value_text: `${PREFIX}-RM`, effective_from: POLICY_FROM,
    } })).operation_policy_id;
    // 사번은 전역 유일이고 서버가 고정 사번으로 찾는다 — 이 DB 에 없으면 만든다.
    ids.worker = (await prisma.worker.upsert({
      where: { worker_no: SYSTEM_WORKER_NO },
      create: { worker_no: SYSTEM_WORKER_NO, worker_name: 'flowtrack', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED' },
      update: { is_active: true },
    })).worker_id;
    ids.otherLot = (await releasedWorkOrder()).lotId;

    // 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
    const jwt = app.get(JwtService);
    for (const [caller, type] of [['tracking', 'TRACKING_SYSTEM'], ['pop', 'POP']]) {
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING',
      } });
      callers[caller] = ['Authorization', `Bearer ${jwt.sign({
        sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
      })}`];
    }
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-WEB`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    callers.web = ['Cookie', `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`];
  }
});
