/**
 * 추적 시스템 연동 — 출하 출고 처리(flowtrack 연동 제안 §3-4 · §8 의 9-1 · HTTP 입구 9-2).
 *
 * 컨테이너 하나를 한 트랜잭션에서 받는다: 시리얼 → LOT → 그 W/O 완제품 창고의 재고를 D/O 마다 출고 전표 하나로 빼고 시리얼을 출고됨으로.
 * 처리한 전송 번호는 다시 처리하지 않고, 거절한 전송은 아무것도 남기지 않는다. 재고와 시리얼은 포장 입고이동 처리로 만든다.
 * HTTP 입구는 연동 단말 토큰만 받는다.
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
import { StockIssue, StockIssueLine, StockIssueService } from '../src/integration/tracking-system/stock-issue.service';
import { StockMoveService } from '../src/integration/tracking-system/stock-move.service';
import { SYSTEM_WORKER_NO } from '../src/integration/tracking-system/tracking-production';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_TSI_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');

interface Packed {
  lotId: bigint;
  serialNos: string[];
}

describe('추적 시스템 연동 — 출하 출고 처리 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let issues: StockIssueService;
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
    issues = app.get(StockIssueService);
    moves = app.get(StockMoveService);
    await fixtures();
  });

  afterAll(async () => {
    await app.close();
  });

  const line = (doNo: string, itemCode: string, serialNos: string[]): StockIssueLine => ({ doNo, itemCode, qty: serialNos.length, serialNos });
  const body = (lines: StockIssueLine[], patch: Partial<StockIssue> = {}): StockIssue => ({
    transmissionId: randomUUID(), containerNo: 'TCLU1234567', viNo: 'VI-2611-001', invoiceNo: null, shipDate: '2026-11-16',
    destination: 'Japan', qty: lines.reduce((sum, entry) => sum + entry.qty, 0), lines, businessDate: '2026-11-16', ...patch,
  });

  it('D/O 마다 출고 전표 하나 · LOT 마다 줄 · 시리얼은 출고됨 · 같은 전송은 다시 빼지 않는다', async () => {
    const [a, b, c] = [await packed(3), await packed(2), await packed(2, 'other')];
    const input = body([line('D1', PREFIX, [...a.serialNos.slice(0, 2), b.serialNos[0]]), line('D2', PREFIX, [a.serialNos[2]]), line('D2', `${PREFIX}-other`, c.serialNos)]);

    expect(await issues.receive(input, ids.plant)).toEqual({ replayed: false });

    const transmission = await prisma.tracking_transmission.findUniqueOrThrow({
      where: { transmission_id: input.transmissionId }, include: { tracking_transmission_document: true },
    });
    expect(transmission).toMatchObject({ kind_code: 'STOCK_ISSUE', plant_id: ids.plant, work_order_id: null });
    const written = await prisma.goods_issue.findMany({
      where: { source_document_type_code: 'TRACKING_TRANSMISSION', source_document_id: transmission.tracking_transmission_id },
      include: { goods_issue_line: { orderBy: { line_no: 'asc' } } }, orderBy: { goods_issue_id: 'asc' },
    });
    expect(written.map((issue) => [issue.issue_type_code, issue.source_warehouse_id, issue.status_code, issue.remarks])).toEqual([
      ['SHIPMENT', ids.warehouse, 'POSTED', 'Container TCLU1234567 · VI VI-2611-001 · D/O D1 · Ship date 2026-11-16 · Destination Japan'],
      ['SHIPMENT', ids.warehouse, 'POSTED', 'Container TCLU1234567 · VI VI-2611-001 · D/O D2 · Ship date 2026-11-16 · Destination Japan'],
    ]);
    expect(written.map((issue) => issue.goods_issue_line.map((entry) => [entry.lot_id, entry.issue_qty.toNumber(), entry.source_location_id]))).toEqual([
      [[a.lotId, 2, ids.location], [b.lotId, 1, ids.location]],
      [[a.lotId, 1, ids.location], [c.lotId, 2, ids.location]],
    ]);
    expect(transmission.tracking_transmission_document.map((doc) => doc.document_type_code)).toEqual(['GOODS_ISSUE', 'GOODS_ISSUE']);
    expect(await statuses(a, b, c)).toEqual(['SHIPPED', 'SHIPPED', 'SHIPPED', 'SHIPPED', 'REGISTERED', 'SHIPPED', 'SHIPPED']);
    expect(await onHand(a, b, c)).toEqual([0, 1, 0]);

    expect(await issues.receive(input, ids.plant)).toEqual({ replayed: true });
    expect(await prisma.goods_issue.count({ where: { source_document_type_code: 'TRACKING_TRANSMISSION', source_document_id: transmission.tracking_transmission_id } })).toBe(2);
    expect(await onHand(a, b, c)).toEqual([0, 1, 0]);
  });

  it('W/O 완제품 위치가 모자라면 같은 창고의 다른 위치에서 뺀다', async () => {
    const lot = await packed(3);
    await prisma.inventory_balance.updateMany({ where: { lot_id: lot.lotId, location_id: ids.location }, data: { on_hand_qty: 1 } });
    await stockAt(lot, ids.shelf, 2);

    await issues.receive(body([line('D1', PREFIX, lot.serialNos)]), ids.plant);

    const issue = await prisma.goods_issue_line.findMany({ where: { lot_id: lot.lotId }, orderBy: { line_no: 'asc' } });
    expect(issue.map((entry) => [entry.source_location_id, entry.issue_qty.toNumber()])).toEqual([[ids.location, 1], [ids.shelf, 2]]);
  });

  const rejections: [string, string, () => Promise<{ input: StockIssue; plantId?: bigint }>][] = [
    ['MES 에 없는 시리얼', 'INVALID', async () => ({ input: body([line('D1', PREFIX, [...(await packed(1)).serialNos, `${PREFIX}-NONE`])]) })],
    ['다른 공장의 시리얼', 'INVALID', async () => ({ input: body([line('D1', PREFIX, (await packed(1)).serialNos)]), plantId: ids.otherPlant })],
    ['줄의 품목과 다른 시리얼', 'INVALID', async () => ({ input: body([line('D1', `${PREFIX}-other`, (await packed(1)).serialNos)]) })],
    ['이미 출고된 시리얼', 'STATE_LOCKED', async () => {
      const lot = await packed(2);
      await issues.receive(body([line('D1', PREFIX, lot.serialNos.slice(0, 1))]), ids.plant);
      return { input: body([line('D1', PREFIX, lot.serialNos)]) };
    }],
    ['머리 수량이 줄 합과 다름', 'INVALID', async () => ({ input: body([line('D1', PREFIX, (await packed(1)).serialNos)], { qty: 2 }) })],
    ['줄 수량이 시리얼 수와 다름', 'INVALID', async () => ({ input: body([{ ...line('D1', PREFIX, (await packed(2)).serialNos), qty: 1 }], { qty: 1 }) })],
    ['본문 안에서 겹친 시리얼', 'INVALID', async () => {
      const [serialNo] = (await packed(1)).serialNos;
      return { input: body([line('D1', PREFIX, [serialNo]), line('D2', PREFIX, [serialNo])]) };
    }],
    ['LOT 이 MES 에서 보류됨', 'STATE_LOCKED', async () => {
      const lot = await packed(1);
      await prisma.lot_hold.create({ data: { lot_id: lot.lotId, reason_code: 'SUSPECT', status_code: 'HELD', held_at: OCCURRED, held_worker_id: ids.worker } });
      return { input: body([line('D1', PREFIX, lot.serialNos)]) };
    }],
    ['출고할 재고가 모자람', 'NEGATIVE_BALANCE', async () => {
      const lot = await packed(2);
      await prisma.inventory_balance.updateMany({ where: { lot_id: lot.lotId }, data: { on_hand_qty: 1 } });
      return { input: body([line('D1', PREFIX, lot.serialNos)]) };
    }],
    ['완제품 재고가 불량 상태', 'NEGATIVE_BALANCE', async () => {
      const lot = await packed(1);
      await prisma.inventory_balance.updateMany({ where: { lot_id: lot.lotId }, data: { quality_status_code: 'DEFECTIVE' } });
      return { input: body([line('D1', PREFIX, lot.serialNos)]) };
    }],
  ];

  it.each(rejections)('거절하면 아무것도 남기지 않는다 — %s', async (_name, code, arrange) => {
    const { input, plantId } = await arrange();
    const serialNos = input.lines.flatMap((entry) => entry.serialNos);
    const before = await snapshot(serialNos);

    await expect(issues.receive(input, plantId ?? ids.plant)).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code })]) });

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
    expect(await snapshot(serialNos)).toEqual(before);
  });

  const post = (input: StockIssue, caller: [string, string], key = input.transmissionId) => request(app.getHttpServer())
    .post('/api/integration/tracking-system/stock-issues').set(...caller).set('Idempotency-Key', key).send(input);

  it('HTTP — 연동 토큰으로 보내면 받고, 같은 전송을 다시 보내면 200 에 replayed 로 답한다', async () => {
    const lot = await packed(2);
    const input = body([line('D1', PREFIX, lot.serialNos)]);

    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: false });
    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: true });
    expect(await onHand(lot)).toEqual([0]);
  });

  it('HTTP — 비고에 쓰는 번호는 비워 보내도 받는다', async () => {
    const lot = await packed(1);

    await post(body([line('D1', PREFIX, lot.serialNos)], { viNo: null, invoiceNo: null, shipDate: null, destination: null }), callers.tracking).expect(200);

    expect((await prisma.goods_issue_line.findFirstOrThrow({ where: { lot_id: lot.lotId }, include: { goods_issue: true } })).goods_issue.remarks)
      .toBe('Container TCLU1234567 · D/O D1');
  });

  it('HTTP — 헤더 요청 키와 전송 번호가 다르면 400 이고 아무것도 남기지 않는다', async () => {
    const input = body([line('D1', PREFIX, (await packed(1)).serialNos)]);

    const response = await post(input, callers.tracking, randomUUID()).expect(400);

    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'transmissionId', code: 'INVALID' })]);
    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
  });

  it.each(['web', 'pop'])('HTTP — 연동 토큰이 아니면(%s) 401 이고 아무것도 남기지 않는다', async (caller) => {
    const input = body([line('D1', PREFIX, (await packed(1)).serialNos)]);

    await post(input, callers[caller]).expect(401);

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
  });

  async function statuses(...lots: Packed[]): Promise<string[]> {
    const serialNos = lots.flatMap((lot) => lot.serialNos);
    const rows = await prisma.serial_number.findMany({ where: { serial_no: { in: serialNos } } });
    return serialNos.map((serialNo) => (rows.find((row) => row.serial_no === serialNo) as (typeof rows)[number]).status_code);
  }

  async function onHand(...lots: Packed[]): Promise<number[]> {
    const rows = await prisma.inventory_balance.groupBy({ by: ['lot_id'], where: { lot_id: { in: lots.map((lot) => lot.lotId) } }, _sum: { on_hand_qty: true } });
    return lots.map((lot) => rows.find((row) => row.lot_id === lot.lotId)?._sum.on_hand_qty?.toNumber() ?? 0);
  }

  async function snapshot(serialNos: string[]): Promise<unknown> {
    const serials = await prisma.serial_number.findMany({ where: { serial_no: { in: serialNos } }, select: { serial_no: true, status_code: true, lot_id: true } });
    const balances = await prisma.inventory_balance.findMany({
      where: { lot_id: { in: [...new Set(serials.map((serial) => serial.lot_id))] } }, select: { inventory_balance_id: true, on_hand_qty: true },
      orderBy: { inventory_balance_id: 'asc' },
    });
    return { serials: serials.map(({ serial_no, status_code }) => [serial_no, status_code]).sort(), balances: balances.map((row) => [row.inventory_balance_id, row.on_hand_qty.toNumber()]) };
  }

  async function stockAt(lot: Packed, locationId: bigint, qty: number): Promise<void> {
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { lot_id: lot.lotId } });
    await prisma.inventory_balance.create({ data: {
      legal_entity_id: balance.legal_entity_id, business_unit_id: balance.business_unit_id, plant_id: balance.plant_id, warehouse_id: balance.warehouse_id,
      location_id: locationId, item_id: balance.item_id, lot_id: balance.lot_id, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
      ownership_type_code: balance.ownership_type_code, on_hand_qty: qty, uom_id: balance.uom_id,
    } });
  }

  /** 자동 계획 W/O 하나에 포장 한 묶음을 받은 상태 — 그 생산 LOT 과 시리얼. */
  async function packed(count: number, item: 'main' | 'other' = 'main'): Promise<Packed> {
    const key = ++seq;
    const itemId = item === 'main' ? ids.item : ids.otherItem;
    const order = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${key}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: itemId,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    const plan = await prisma.production_plan.create({ data: {
      production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: OCCURRED, planned_qty: 10,
      uom_id: ids.uom, bom_id: item === 'main' ? ids.bom : ids.otherBom, routing_id: ids.routing, status_code: 'CONFIRMED', confirmed_at: OCCURRED,
      created_automatically: true,
    } });
    const workOrder = await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, production_plan_id: plan.production_plan_id, routing_operation_id: ids.operation,
      item_id: itemId, order_qty: 10, uom_id: ids.uom, status_code: 'RELEASED', released_at: OCCURRED, default_fg_location_id: ids.location,
    } });
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${key}`, item_id: itemId, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 10,
      uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrder.work_order_id, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
    } });
    const serialNos = Array.from({ length: count }, (_, index) => `${PREFIX}-SN-${key}-${index + 1}`);
    await moves.receive({
      transmissionId: randomUUID(), workOrderNo: workOrder.work_order_no, mesWorkOrderId: Number(workOrder.work_order_id),
      itemCode: item === 'main' ? PREFIX : `${PREFIX}-other`, qty: count, serialNos, packedFrom: '2026-11-16T01:00:00.000Z',
      packedTo: '2026-11-16T03:00:00.000Z', businessDate: '2026-11-16',
    }, ids.plant);
    return { lotId: lot.lot_id, serialNos };
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
    for (const [key, code] of [['item', PREFIX], ['otherItem', `${PREFIX}-other`]]) {
      ids[key] = (await prisma.item.create({ data: { item_code: code, item_name: code, item_type_code: 'FINISHED', base_uom_id: ids.uom } })).item_id;
    }
    const process = await prisma.process.create({ data: { process_code: PREFIX, process_name: '조립', process_type_code: 'ASSEMBLY' } });
    ids.routing = (await prisma.routing.create({ data: {
      item_id: ids.item, routing_code: `RT-${PREFIX}`, routing_version: 1, status_code: 'CONFIRMED',
    } })).routing_id;
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: ids.routing, operation_seq: 10, process_id: process.process_id, operation_name: '조립',
    } })).routing_operation_id;
    for (const [key, itemKey] of [['bom', 'item'], ['otherBom', 'otherItem']]) {
      ids[key] = (await prisma.bom.create({ data: {
        parent_item_id: ids[itemKey], plant_id: ids.plant, bom_code: `ERP-${PREFIX}-${key}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
        effective_from: OCCURRED, base_qty: 1, base_uom_id: ids.uom,
      } })).bom_id;
    }
    for (const [key, code, type] of [['warehouse', 'FG', 'FINISHED'], ['rm', 'RM', 'MATERIAL']]) {
      ids[key] = (await prisma.warehouse.create({ data: {
        plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-${code}`, warehouse_name: code, warehouse_type_code: type,
        management_level_code: 'LOCATION',
      } })).warehouse_id;
    }
    for (const [key, code] of [['location', 'FG-L'], ['shelf', 'FG-S']]) {
      ids[key] = (await prisma.location.create({ data: {
        warehouse_id: ids.warehouse, location_code: `${PREFIX}-${code}`, location_name: code, location_type_code: 'BIN',
      } })).location_id;
    }
    await prisma.operation_policy.create({ data: {
      policy_code: 'BACKFLUSH_WAREHOUSE', plant_id: ids.plant, value_text: `${PREFIX}-RM`, effective_from: new Date('2026-01-01'),
    } });
    // 사번은 전역 유일이고 서버가 고정 사번으로 찾는다 — 이 DB 에 없으면 만든다.
    ids.worker = (await prisma.worker.upsert({
      where: { worker_no: SYSTEM_WORKER_NO },
      create: { worker_no: SYSTEM_WORKER_NO, worker_name: 'flowtrack', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED' },
      update: { is_active: true },
    })).worker_id;

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
