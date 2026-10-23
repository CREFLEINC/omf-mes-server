/**
 * 세션 없는 중단을 막고, 중단·세션 없음 W/O 를 POP 작업 시작으로 다시 연다(장부 P-111) (e2e).
 *
 * `:hold` 는 열린 작업 세션(중단 포함)이 있을 때만 된다. 작업 시작은 중단·열린 세션 없음 W/O 를 같은 트랜잭션에서
 * 재개하고 새 세션을 연다 — 중단 세션이 열려 있으면 409(그 세션의 재개로).
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

const PREFIX = 'SUSPRS';
const RELEASED_AT = new Date('2026-10-23T01:00:00.000Z');

describe('세션 없는 중단 막기 · 중단 W/O 재시작 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
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

  it('세션 없는 W/O 의 중단은 400 이고 W/O 는 그대로다', async () => {
    const workOrderId = await workOrder('A', 'IN_PROGRESS');

    const response = await hold(workOrderId).expect(400);

    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(response.body.errors[0].message).toContain('작업을 시작한 뒤에 중단하세요');
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('IN_PROGRESS');
  });

  it('작업을 시작한 W/O 는 중단된다', async () => {
    const workOrderId = await workOrder('B', 'RELEASED');
    await start(workOrderId).expect(201);

    await hold(workOrderId).expect(200);

    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('SUSPENDED');
  });

  it('중단·세션 없음 W/O 를 POP 작업 시작으로 다시 시작한다 — W/O 재개 · 새 세션 · START 사건만', async () => {
    const workOrderId = await workOrder('C', 'SUSPENDED');
    const before = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } });

    const response = await start(workOrderId).expect(201);

    expect(response.body).toMatchObject({ statusCode: 'RUNNING', workOrderId: Number(workOrderId) });
    const after = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } });
    expect(after).toMatchObject({ status_code: 'IN_PROGRESS', version_no: before.version_no + 1 });
    const events = await prisma.work_session_event.findMany({ where: { work_session_id: BigInt(response.body.workSessionId) } });
    expect(events.map((event) => event.event_type_code)).toEqual(['START']);
    // 재시작도 작업 시작 알림 한 건이다 — 재개가 따로 알리지 않는다.
    const notices = await prisma.notification_event.findMany({ where: { aggregate_type_code: 'WORK_ORDER', aggregate_id: workOrderId } });
    expect(notices.map((notice) => notice.event_type_code)).toEqual(['WORK_SESSION_STARTED']);
  });

  it('중단 세션이 열려 있으면 작업 시작은 409 다 — 그 세션의 재개로', async () => {
    const workOrderId = await workOrder('D', 'RELEASED');
    const session = await start(workOrderId).expect(201);
    await hold(workOrderId).expect(200);
    await asPop(request(app.getHttpServer()).post(`/api/production/work-sessions/${String(session.body.workSessionId)}/events`))
      .send({ eventTypeCode: 'STOP', occurredAt: new Date().toISOString(), reasonCode: 'EQUIPMENT_FAILURE' })
      .expect(201);

    const response = await start(workOrderId).expect(409);

    expect(response.body).toMatchObject({ code: 'OPEN_SESSION_EXISTS' });
    expect(response.body.message).toContain('목록을 새로 고친 뒤 [재개]를 누르세요');
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('SUSPENDED');
  });

  it('낡은 If-Match 로 중단 W/O 를 시작하면 409 이고 W/O 는 그대로다', async () => {
    const workOrderId = await workOrder('F', 'SUSPENDED');
    const before = await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } });

    await start(workOrderId).set('If-Match', `"${String(before.version_no + 5)}"`).expect(409);

    expect(await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } }))
      .toMatchObject({ status_code: 'SUSPENDED', version_no: before.version_no });
    expect(await prisma.work_session.count({ where: { work_order_id: workOrderId } })).toBe(0);
  });

  it('마감·편성 W/O 의 작업 시작은 400 이고 할 일을 알린다 — 열린 세션보다 상태가 먼저다', async () => {
    // 마감 W/O 에 세션이 열려 있어도 상태 문구가 먼저다(취소 W/O 는 단말 범위가 먼저 401 로 막는다).
    const closedId = await workOrder('G', 'CLOSED');
    await prisma.work_session.create({ data: {
      work_order_id: closedId, session_no: 1, terminal_id: ids.terminal, started_at: RELEASED_AT, status_code: 'STOPPED',
      idempotency_key: `${PREFIX}-WS-G`,
    } });
    const closed = await start(closedId).expect(400);
    expect(closed.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(closed.body.errors[0].message).toContain('마감된 W/O 입니다');
    const planned = await start(await workOrder('H', 'PLANNED')).expect(400);
    expect(planned.body.errors[0].message).toContain('배포한 뒤 시작하세요');
  });

  it('작업 전 점검은 중단 W/O 에서도 작업 시작과 같다 — 상태로 막지 않는다', async () => {
    const workOrderId = await workOrder('E', 'SUSPENDED');

    await asPop(request(app.getHttpServer()).post('/api/production/precheck-decisions'))
      .send({
        workOrderId: Number(workOrderId), equipmentId: Number(ids.equipment), decidedAt: new Date().toISOString(),
        controlLevelCode: 'WARN', decisionCode: 'PASSED',
      })
      .expect(201);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function asPop(test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${token}`).set('X-Worker-No', workerNo).set('Idempotency-Key', randomUUID());
  }

  function hold(workOrderId: bigint): request.Test {
    return asPop(request(app.getHttpServer()).post(`/api/production/work-orders/${String(workOrderId)}:hold`))
      .send({ reasonCode: 'EQUIPMENT_FAILURE', occurredAt: new Date().toISOString() });
  }

  function start(workOrderId: bigint): request.Test {
    return asPop(request(app.getHttpServer()).post('/api/production/work-sessions'))
      .send({ workOrderId: Number(workOrderId), equipmentId: Number(ids.equipment), startedAt: new Date().toISOString() });
  }

  async function workOrder(key: string, status: string): Promise<bigint> {
    return (await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, routing_operation_id: ids.operation, item_id: ids.item, order_qty: 10, uom_id: ids.uom,
      status_code: status, production_line_id: ids.line, released_at: RELEASED_AT,
    } })).work_order_id;
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
    ids.process = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } }))
      .process_id;
    ids.line = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LINE`, line_name: PREFIX } }))
      .production_line_id;
    ids.equipment = (await prisma.equipment.create({ data: {
      plant_id: ids.plant, production_line_id: ids.line, equipment_code: `${PREFIX}-EQ`, equipment_name: PREFIX,
      equipment_type_code: 'PRESS', status_code: 'IN_SERVICE',
    } })).equipment_id;
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: ids.process, operation_name: PREFIX,
    } })).routing_operation_id;
    const worker = await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: `${PREFIX}-작업자`, business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED',
    } });
    workerNo = worker.worker_no;
    const terminal = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING', equipment_id: ids.equipment,
    } });
    ids.terminal = terminal.terminal_id;
    await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: ids.process, can_start_work: true } });
    token = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code,
      plantId: Number(ids.plant), equipmentId: Number(ids.equipment),
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    const sessions = `SELECT work_session_id FROM production.work_session WHERE work_order_id IN (${workOrders})`;
    for (const sql of [
      `DELETE FROM app.notification_event WHERE aggregate_type_code = 'WORK_ORDER' AND aggregate_id IN (${workOrders})`,
      `DELETE FROM production.precheck_decision WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_session_event WHERE work_session_id IN (${sessions})`,
      `DELETE FROM production.work_session_worker WHERE work_session_id IN (${sessions})`,
      `DELETE FROM production.work_session WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
