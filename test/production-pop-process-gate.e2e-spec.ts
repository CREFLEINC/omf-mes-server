/**
 * POP 저장 API 의 단말 공정 판정 — 자재 투입·실적 저장은 그 W/O 공정의 이 단말 매핑에서 화면과 같은 기능 플래그를 본다
 * (투입 = 자재 투입, 실적 = 실적 입력 · 장부 P-109) (e2e).
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'POPGATE';
const STARTED_AT = new Date('2026-10-23T01:00:00.000Z');

type Flags = { can_start_work?: boolean; can_input_material?: boolean; can_input_result?: boolean };

describe('POP 저장 API 의 단말 공정 판정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workerNo: string;
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

  it('투입만 켠 단말 — 투입은 단말 판정을 지나고 실적은 401(「실적 입력」을 켜라)', async () => {
    const token = await terminal('MAT', { [String(ids.process)]: { can_input_material: true } });

    // 단말 판정을 지나 업무 검증까지 간다 — 이 픽스처엔 자재 명세가 없어 400 이지만 401 이 아니다.
    const passed = await consume(token);
    expect(passed.status).not.toBe(401);
    expect(passed.body.errors?.[0]?.code).not.toBe('PERMISSION_DENIED');
    const result = await saveResult(token).expect(401);
    expect(result.body.errors[0].message).toContain('「실적 입력」');
  });

  it('실적만 켠 단말 — 실적은 저장되고 투입은 401(「자재 투입」을 켜라)', async () => {
    const token = await terminal('RES', { [String(ids.process)]: { can_input_result: true } });

    await saveResult(token).expect(201);
    const consumed = await consume(token).expect(401);
    expect(consumed.body.errors[0].message).toContain('「자재 투입」');
  });

  it('공정이 여러 개 매핑된 단말 — 다른 공정의 플래그가 아니라 W/O 공정 행으로 판정한다', async () => {
    // 다른 공정에는 투입·실적을 다 켜고, W/O 공정에는 작업 시작만 켰다.
    const token = await terminal('MULTI', {
      [String(ids.otherProcess)]: { can_input_material: true, can_input_result: true },
      [String(ids.process)]: { can_start_work: true },
    });

    await consume(token).expect(401);
    await saveResult(token).expect(401);
  });

  it('작업 시작만 켠 단말 — 투입·실적 모두 401', async () => {
    const token = await terminal('START', { [String(ids.process)]: { can_start_work: true } });

    const consumed = await consume(token).expect(401);
    expect(consumed.body.errors[0].message).toContain('「자재 투입」');
    const result = await saveResult(token).expect(401);
    expect(result.body.errors[0].message).toContain('「실적 입력」');
  });

  describe('W/O 단위 조회 — 화면에 들어갈 수 있으면 읽는다', () => {
    const read = (token: string, path: string, query: Record<string, string> = {}) =>
      request(app.getHttpServer()).get(path).query(query).set('Authorization', `Bearer ${token}`);

    it('실적만 켠 다공정 단말 — 배포된 W/O 의 상세·투입 목록·LOT 목록을 읽는다', async () => {
      const token = await terminal('READ', {
        [String(ids.otherProcess)]: { can_start_work: true },
        [String(ids.process)]: { can_input_result: true },
      });
      const workOrderId = String(ids.workOrder);

      await read(token, `/api/production/work-orders/${workOrderId}`).expect(200);
      await read(token, '/api/production/material-consumptions', { workOrderId }).expect(200);
      await read(token, '/api/trace/lots', { workOrderId }).expect(200);
    });

    it('그 W/O 공정에 매핑이 없으면 401 이다', async () => {
      const token = await terminal('READ2', { [String(ids.process)]: { can_input_result: true } });
      const unmapped = (await prisma.work_order.create({ data: {
        work_order_no: `${PREFIX}-WO-UNMAPPED`, routing_operation_id: ids.otherOperation, item_id: ids.item, order_qty: 10,
        uom_id: ids.uom, status_code: 'IN_PROGRESS', production_line_id: ids.line, released_at: STARTED_AT,
      } })).work_order_id;

      await read(token, `/api/production/work-orders/${String(unmapped)}`).expect(401);
      await read(token, '/api/production/material-consumptions', { workOrderId: String(unmapped) }).expect(401);
      await read(token, '/api/trace/lots', { workOrderId: String(unmapped) }).expect(401);
    });
  });

  describe('재작업 실적(P-04-03)의 재작업 W/O 목록', () => {
    const list = (token: string, query: Record<string, string>) => request(app.getHttpServer())
      .get('/api/production/work-orders').query({ q: `${PREFIX}-RW`, size: '50', ...query }).set('Authorization', `Bearer ${token}`);
    const nos = (response: request.Response) => response.body.items.map((row: { workOrderNo: string }) => row.workOrderNo).sort();

    it('배포 전 재작업 W/O 를 단말 토큰으로 본다 — 그 공장·실적 입력이 켜진 공정의 재작업 W/O 만', async () => {
      const token = await terminal('RW1', {
        [String(ids.process)]: { can_input_result: true },
        [String(ids.otherProcess)]: { can_start_work: true },
      });

      const planned = await list(token, { workOrderTypeCode: 'REWORK', statusCode: 'PLANNED' }).expect(200);

      // 라인 없는 배포 전 W/O 는 계획의 ERP W/O 공장으로 본다. 다른 공장·실적 입력이 꺼진 공정·일반 W/O 는 빠진다.
      expect(nos(planned)).toEqual([`${PREFIX}-RW-PLANNED`]);
      const open = await list(token, { workOrderTypeCode: 'REWORK', open: 'true' }).expect(200);
      expect(nos(open)).toEqual([`${PREFIX}-RW-RELEASED`]);
    });

    it('재작업·PLANNED 짝이 아니면 여전히 401 이다', async () => {
      const token = await terminal('RW2', { [String(ids.process)]: { can_input_result: true } });

      await list(token, { statusCode: 'PLANNED' }).expect(401);
      await list(token, { workOrderTypeCode: 'REWORK', statusCode: 'CLOSED' }).expect(401);
    });

    it('정상 흐름 — 배포된 재작업 W/O 를 골라 실적을 저장한다(배포 전 W/O 는 실적을 받지 않는다)', async () => {
      const token = await terminal('RW3', { [String(ids.process)]: { can_input_result: true } });
      const result = (workOrderId: bigint) => asPop(request(app.getHttpServer()).post('/api/production/production-results'), token).send({
        workOrderId: Number(workOrderId), goodQty: 1, uomId: Number(ids.uom), resultSourceCode: 'MANUAL', occurredAt: new Date().toISOString(),
      });

      await result(ids.reworkReleased).expect(201);
      // 배포 전 W/O 는 단말 범위(배포됨)에서 먼저 막힌다 — 목록에서 보이기만 하는 이유다.
      await result(ids.reworkPlanned).expect(401);
    });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function asPop(test: request.Test, token: string): request.Test {
    return test.set('Authorization', `Bearer ${token}`).set('X-Worker-No', workerNo).set('Idempotency-Key', randomUUID());
  }

  function consume(token: string): request.Test {
    return asPop(request(app.getHttpServer()).post('/api/production/material-consumptions'), token).send({
      workOrderId: Number(ids.workOrder), itemId: Number(ids.material), lotId: Number(ids.materialLot),
      inputQty: 1, uomId: Number(ids.uom), occurredAt: new Date().toISOString(),
    });
  }

  function saveResult(token: string): request.Test {
    return asPop(request(app.getHttpServer()).post('/api/production/production-results'), token).send({
      workOrderId: Number(ids.workOrder), goodQty: 1, uomId: Number(ids.uom), resultSourceCode: 'MANUAL',
      occurredAt: new Date().toISOString(),
    });
  }

  /** 공정별 기능 플래그를 가진 POP 단말 — 적지 않은 플래그는 꺼져 있다(작업지시 마감만 기본 켜짐). */
  async function terminal(suffix: string, mappings: Record<string, Flags>): Promise<string> {
    const row = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP-${suffix}`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING',
    } });
    for (const [processId, flags] of Object.entries(mappings)) {
      await prisma.terminal_process.create({ data: { terminal_id: row.terminal_id, process_id: BigInt(processId), ...flags } });
    }
    return app.get(JwtService).sign({
      sub: Number(row.terminal_id), typ: 'terminal', tv: row.token_version, terminalCode: row.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function fixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX,
    } });
    ids.plant = (await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P1`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    ids.item = (await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom,
    } })).item_id;
    ids.material = (await prisma.item.create({ data: {
      item_code: `${PREFIX}-MAT`, item_name: PREFIX, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true,
    } })).item_id;
    ids.process = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } }))
      .process_id;
    ids.otherProcess = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR2`, process_name: PREFIX, process_type_code: 'PRODUCTION' } }))
      .process_id;
    const line = await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LINE`, line_name: PREFIX } });
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: ids.process, operation_name: PREFIX,
    } });
    await reworkFixtures(entity.legal_entity_id, unit.business_unit_id, routing.routing_id, operation.routing_operation_id, line.production_line_id);
    ids.workOrder = (await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: ids.item, order_qty: 100,
      uom_id: ids.uom, status_code: 'IN_PROGRESS', production_line_id: line.production_line_id, released_at: STARTED_AT,
    } })).work_order_id;
    ids.materialLot = (await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-MLOT`, item_id: ids.material, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 100,
      uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 990001n, status_code: 'NORMAL',
    } })).lot_id;
    const worker = await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: `${PREFIX}-작업자`, business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED',
    } });
    workerNo = worker.worker_no;
  }

  /**
   * 재작업 W/O 넷 — 배포 전(라인 없음, 이 공장 계획) · 배포됨(라인 있음) · 다른 공장 계획의 배포 전 · 실적 입력이 꺼진 공정의 배포 전.
   * 배포 전 재작업 W/O 는 발행 직후라 라인이 없다(`rework-work-order.service.ts`).
   */
  async function reworkFixtures(legalEntityId: bigint, unitId: bigint, routingId: bigint, operationId: bigint, lineId: bigint): Promise<void> {
    const otherPlant = await prisma.plant.create({ data: {
      legal_entity_id: legalEntityId, plant_code: `${PREFIX}-P2`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const bom = await prisma.bom.create({ data: {
      parent_item_id: ids.item, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'ACTIVE',
      effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
    } });
    const plan = async (suffix: string, plantId: bigint) => {
      const order = await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-PO-${suffix}`, business_unit_id: unitId, plant_id: plantId, item_id: ids.item,
        order_qty: 100, uom_id: ids.uom, status_code: 'CONFIRMED',
      } });
      return (await prisma.production_plan.create({ data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${suffix}`, plan_date: new Date('2026-10-23T00:00:00.000Z'),
        planned_qty: 100, uom_id: ids.uom, bom_id: bom.bom_id, routing_id: routingId, status_code: 'CONFIRMED',
      } })).production_plan_id;
    };
    const ownPlan = await plan('OWN', ids.plant);
    const otherPlan = await plan('OTHER', otherPlant.plant_id);
    const otherOperation = await prisma.routing_operation.create({ data: {
      routing_id: routingId, operation_seq: 20, process_id: ids.otherProcess, operation_name: PREFIX,
    } });
    ids.otherOperation = otherOperation.routing_operation_id;
    ids.line = lineId;
    const rework = (suffix: string, data: Record<string, unknown>) => prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-RW-${suffix}`, routing_operation_id: operationId, item_id: ids.item, order_qty: 10, uom_id: ids.uom,
      work_order_type_code: 'REWORK', status_code: 'PLANNED', production_plan_id: ownPlan, ...data,
    } });
    ids.reworkPlanned = (await rework('PLANNED', {})).work_order_id;
    ids.reworkReleased = (await rework('RELEASED', { status_code: 'IN_PROGRESS', production_line_id: lineId, released_at: STARTED_AT })).work_order_id;
    await rework('OTHERPLANT', { production_plan_id: otherPlan });
    await rework('NORESULT', { routing_operation_id: otherOperation.routing_operation_id });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM production.production_result WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.material_consumption WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}-%'`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: `${PREFIX}-` } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: `${PREFIX}-` } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: `${PREFIX}-` } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
