/**
 * POP 작업지시 마감 — 단말 토큰 + `X-Worker-No` 로 `:close` 를 부른다(장부 P-104) (e2e).
 *
 * 단말은 그 W/O 공정 매핑의 「작업지시 마감」(`canCloseWorkOrder`, 기본 열림)이 있어야 한다. 마감 작업자가 W/O 에 남고,
 * 마감 결과(잔량 처분·사유·폐번 LOT 수)가 상세에 보인다. 열린 세션이 있으면 409 가 어느 단말·누구의 세션인지 싣는다.
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'WOCLOSE';
const WORK_ORDERS = '/api/production/work-orders';
const STARTED_AT = new Date('2026-10-22T01:00:00.000Z');
const WORKER_NAME = '마감작업자';

interface Pop {
  token: string;
  terminalId: bigint;
}

describe('POP 작업지시 마감 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let open: Pop;
  let closedFlag: Pop;
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

  it('POP 이 미달 W/O 를 잔량 처분·사유와 함께 마감한다 — 마감 작업자가 남고 대기 LOT 은 폐번, 진행 중 LOT 은 그대로', async () => {
    const workOrderId = await workOrderWithLots('A');

    const closed = await close(open, workOrderId, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' }).expect(200);

    expect(closed.body).toMatchObject({
      statusCode: 'CLOSED', closeDispositionCode: 'WRITE_OFF', completionVarianceReasonCode: 'MATERIAL_SHORTAGE',
      closedWorkerId: Number(ids.worker), closedWorkerNo: workerNo, closedWorkerName: WORKER_NAME, voidedLotCount: 1,
    });
    const lots = await prisma.lot.findMany({ where: { lot_no: { startsWith: `${PREFIX}-A-` } }, orderBy: { lot_no: 'asc' } });
    expect(lots.map((lot) => [lot.lot_no, lot.lifecycle_status_code, lot.completed_at])).toEqual([
      [`${PREFIX}-A-1`, 'ACTIVE', null],
      [`${PREFIX}-A-2`, 'VOIDED', null],
    ]);
    const detail = await request(app.getHttpServer()).get(`${WORK_ORDERS}/${String(workOrderId)}`).set('Cookie', cookie).expect(200);
    expect(detail.body).toMatchObject({ closeDispositionCode: 'WRITE_OFF', closedWorkerName: WORKER_NAME, voidedLotCount: 1 });
  });

  it('중단된 W/O 를 세션 종료 뒤 미달 마감한다 — 중단 세션이 열려 있으면 먼저 409', async () => {
    const workOrderId = await workOrderWithLots('S');
    await prisma.work_order.update({ where: { work_order_id: workOrderId }, data: { status_code: 'SUSPENDED' } });
    const session = await prisma.work_session.create({ data: {
      work_order_id: workOrderId, session_no: 1, terminal_id: open.terminalId, started_at: STARTED_AT,
      status_code: 'STOPPED', idempotency_key: `${PREFIX}-WS-S`,
    } });
    const body = { remainderDispositionCode: 'CARRY_OVER', reasonCode: 'MATERIAL_SHORTAGE' };

    await close(open, workOrderId, body).expect(409);
    await asPop(request(app.getHttpServer()).post(`/api/production/work-sessions/${String(session.work_session_id)}:end`), open)
      .set('Idempotency-Key', randomUUID())
      .send({ endedAt: new Date().toISOString() })
      .expect(200);
    const closed = await close(open, workOrderId, body).expect(200);

    expect(closed.body).toMatchObject({ statusCode: 'CLOSED', closeDispositionCode: 'CARRY_OVER', closedWorkerNo: workerNo });
  });

  it('If-Match 없는 POP 마감은 받지 않는다 — 온라인 전용', async () => {
    const workOrderId = await workOrderWithLots('B');

    const response = await asPop(request(app.getHttpServer()).post(`${WORK_ORDERS}/${String(workOrderId)}:close`), open)
      .set('Idempotency-Key', randomUUID())
      .send({ remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' });

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'REQUIRED' });
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).closed_at).toBeNull();
  });

  it('작업지시 마감 권한이 꺼진 단말은 401 이고 켤 곳을 알려 준다', async () => {
    const workOrderId = await workOrderWithLots('C');

    const response = await close(closedFlag, workOrderId, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' }).expect(401);

    expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(response.body.errors[0].message).toContain('작업지시 마감');
  });

  it('열린 세션이 있으면 409 가 단말·작업자·시작 시각을 싣고, 세션 조회도 같은 단말·작업자를 낸다', async () => {
    const workOrderId = await workOrderWithLots('D');
    const session = await prisma.work_session.create({ data: {
      work_order_id: workOrderId, session_no: 1, terminal_id: open.terminalId, started_at: STARTED_AT,
      status_code: 'RUNNING', idempotency_key: `${PREFIX}-WS-D`,
    } });
    await prisma.work_session_worker.create({ data: {
      work_session_id: session.work_session_id, worker_id: ids.worker, worker_role_code: 'MAIN', joined_at: STARTED_AT,
    } });

    const response = await close(open, workOrderId, { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' }).expect(409);

    expect(response.body).toMatchObject({
      code: 'OPEN_SESSION_EXISTS',
      openSessions: [{
        workSessionId: Number(session.work_session_id), terminalCode: `${PREFIX}-POP-1`, workerNo, workerName: WORKER_NAME,
        startedAt: STARTED_AT.toISOString(), statusCode: 'RUNNING',
      }],
    });
    expect(response.body.message).toContain(`${PREFIX}-POP-1`);
    const sessions = await request(app.getHttpServer())
      .get('/api/production/work-sessions')
      .query({ open: 'true', workOrderId: String(workOrderId) })
      .set('Cookie', cookie)
      .expect(200);
    expect(sessions.body.items[0]).toMatchObject({ terminalCode: `${PREFIX}-POP-1`, workerNo, workerName: WORKER_NAME });
  });

  it('단말 공정 매핑 저장은 canCloseWorkOrder 를 생략하면 켜고, false 면 끈다', async () => {
    const terminal = await prisma.terminal.findUniqueOrThrow({ where: { terminal_id: open.terminalId } });
    const put = (items: Record<string, unknown>[], version: number) => request(app.getHttpServer())
      .put(`/api/mdm/terminals/${String(open.terminalId)}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(version)}"`)
      .send({ items });

    const omitted = await put([{ processId: Number(ids.process), canStartWork: true }], terminal.version_no).expect(200);
    expect(omitted.body.items[0]).toMatchObject({ canStartWork: true, canCloseWorkOrder: true });
    const after = await prisma.terminal.findUniqueOrThrow({ where: { terminal_id: open.terminalId } });
    const off = await put([{ processId: Number(ids.process), canStartWork: true, canCloseWorkOrder: false }], after.version_no).expect(200);
    expect(off.body.items[0]).toMatchObject({ canCloseWorkOrder: false });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function asPop(test: request.Test, pop: Pop): request.Test {
    return test.set('Authorization', `Bearer ${pop.token}`).set('X-Worker-No', workerNo);
  }

  function close(pop: Pop, workOrderId: bigint, body: Record<string, unknown>): request.Test {
    const test = request(app.getHttpServer()).post(`${WORK_ORDERS}/${String(workOrderId)}:close`);
    // If-Match 는 W/O 행 버전이다(상세 ETag 와 같은 값) — 마감은 온라인 전용이라 늘 싣는다.
    return asPop(test, pop).set('Idempotency-Key', randomUUID()).set('If-Match', `"${String(versions.get(workOrderId))}"`).send(body);
  }

  const versions = new Map<bigint, number>();

  /** 지시 10 · 양품 4(실적 1건) — 실적이 붙은 LOT 1(진행 중)과 실적 없는 LOT 2(대기)가 있는 미달 W/O. */
  async function workOrderWithLots(key: string): Promise<bigint> {
    const workOrder = await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, routing_operation_id: ids.operation, item_id: ids.item, order_qty: 10,
      uom_id: ids.uom, status_code: 'IN_PROGRESS', production_line_id: ids.line, released_at: STARTED_AT,
    } });
    versions.set(workOrder.work_order_id, workOrder.version_no);
    const lot = (seq: number, lifecycle: string) => prisma.lot.create({ data: {
      lot_no: `${PREFIX}-${key}-${String(seq)}`, item_id: ids.item, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 5,
      uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrder.work_order_id, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: lifecycle, work_order_lot_seq: seq,
    } });
    const active = await lot(1, 'ACTIVE');
    await lot(2, 'WAITING');
    const result = await prisma.production_result.create({ data: {
      production_result_no: `${PREFIX}-PR-${key}`, work_order_id: workOrder.work_order_id, result_sequence: 1, good_qty: 4,
      uom_id: ids.uom, result_source_code: 'MANUAL', occurred_at: STARTED_AT, worker_id: ids.worker, status_code: 'CONFIRMED',
      idempotency_key: `${PREFIX}-PR-${key}`,
    } });
    await prisma.production_result_lot_allocation.create({ data: {
      production_result_id: result.production_result_id, lot_id: active.lot_id, allocated_qty: 4, uom_id: ids.uom,
    } });
    return workOrder.work_order_id;
  }

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.createMany({ data: ['W-02-05', 'W-CO-06'].map((permission_code) => ({ role_id: ids.role, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;

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
      item_code: `${PREFIX}-ITEM`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom, lot_controlled: true,
    } })).item_id;
    ids.process = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } }))
      .process_id;
    ids.line = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LINE`, line_name: PREFIX } }))
      .production_line_id;
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: ids.process, operation_name: PREFIX,
    } })).routing_operation_id;
    const worker = await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: WORKER_NAME, business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED',
    } });
    ids.worker = worker.worker_id;
    workerNo = worker.worker_no;

    const pop = async (suffix: string, canClose: boolean): Promise<Pop> => {
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-POP-${suffix}`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING',
      } });
      await prisma.terminal_process.create({ data: {
        terminal_id: terminal.terminal_id, process_id: ids.process, can_start_work: true, can_close_work_order: canClose,
      } });
      return {
        terminalId: terminal.terminal_id,
        token: app.get(JwtService).sign({
          sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
          terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
        }),
      };
    };
    open = await pop('1', true);
    closedFlag = await pop('2', false);
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    const userIds = users.map((row) => row.app_user_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM integration.integration_message WHERE target_type_code = 'WORK_ORDER' AND target_id IN (${workOrders})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}-%')`,
      `DELETE FROM production.production_result_lot_allocation WHERE production_result_id IN (SELECT production_result_id FROM production.production_result WHERE work_order_id IN (${workOrders}))`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_session_event WHERE work_session_id IN (SELECT work_session_id FROM production.work_session WHERE work_order_id IN (${workOrders}))`,
      `DELETE FROM production.work_session_worker WHERE work_session_id IN (SELECT work_session_id FROM production.work_session WHERE work_order_id IN (${workOrders}))`,
      `DELETE FROM production.work_session WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}-%'`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
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
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
