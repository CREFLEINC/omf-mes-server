/**
 * W/O 일자별 실적 — 마감 상세의 일자별 표(장부 P-122) (e2e).
 *
 * 정정된 원본은 빼고 정정본만 세며(W/O 누계와 같은 값), 자정을 넘는 야간 교대의 새벽 실적은 교대 시작일로 묶인다.
 * 실적에 교대가 비어 있으면 실적 시각을 공장 교대로 다시 판정한다 — 야간 세션이 다음 날 낮까지 열려 있어도 낮 실적은 야간이 아니다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'WODAILY';
const WORK_ORDERS = '/api/production/work-orders';
/** 현지(UTC+7) 시각으로 적는다. */
const local = (iso: string) => new Date(`${iso}+07:00`);

describe('W/O 일자별 실적 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let noPermCookie: string;
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

  it('야간 새벽 실적은 교대 시작일로, 정정된 원본은 빼고 정정본만 센다 — 열린 야간 세션의 낮 실적은 교대 없음, 합계는 W/O 누계와 같다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${WORK_ORDERS}/${String(ids.workOrder)}/daily-results`).set('Cookie', cookie).expect(200);

    const zeros = { defectQty: 0, holdQty: 0, scrapQty: 0, reworkQty: 0 };
    expect(response.body).toEqual({
      uomId: Number(ids.uom),
      uomCode: expect.any(String),
      orderQty: 20,
      items: [
        {
          workDate: '2026-10-21', goodQty: 9, ...zeros, defectQty: 1, scrapQty: 2, resultCount: 2, correctedCount: 1,
          firstAt: local('2026-10-21T23:00:00').toISOString(), lastAt: local('2026-10-22T02:00:00').toISOString(),
          byShift: [{ shiftId: Number(ids.night), shiftName: `${PREFIX} 야간`, goodQty: 9, ...zeros, defectQty: 1, scrapQty: 2, resultCount: 2, correctedCount: 1 }],
        },
        {
          workDate: '2026-10-22', goodQty: 2, ...zeros, resultCount: 1, correctedCount: 0,
          firstAt: local('2026-10-22T10:00:00').toISOString(), lastAt: local('2026-10-22T10:00:00').toISOString(),
          byShift: [{ shiftId: null, shiftName: '교대 없음', goodQty: 2, ...zeros, resultCount: 1, correctedCount: 0 }],
        },
      ],
      totals: { goodQty: 11, ...zeros, defectQty: 1, scrapQty: 2, resultCount: 3, correctedCount: 1 },
    });

    const detail = await request(app.getHttpServer())
      .get(`${WORK_ORDERS}/${String(ids.workOrder)}?withProgress=true`).set('Cookie', cookie).expect(200);
    const { goodQty, defectQty, holdQty, scrapQty, reworkQty } = response.body.totals;
    expect(detail.body.progress).toMatchObject({ goodQty, defectQty, holdQty, scrapQty, reworkQty });
  });

  it('실적이 없는 W/O 는 빈 목록과 0 합계다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${WORK_ORDERS}/${String(ids.emptyWorkOrder)}/daily-results`).set('Cookie', cookie).expect(200);

    expect(response.body).toMatchObject({ items: [], totals: { goodQty: 0, resultCount: 0, correctedCount: 0 } });
  });

  it('없는 W/O 는 404 — 문구가 목록을 새로 고치라고 안내한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${WORK_ORDERS}/999999999999/daily-results`).set('Cookie', cookie).expect(404);

    expect(JSON.stringify(response.body)).toContain('W/O 목록을 새로 고쳐');
  });

  it('경로 형식이 틀리면 400, 권한이 없으면 403 이다', async () => {
    await request(app.getHttpServer()).get(`${WORK_ORDERS}/abc/daily-results`).set('Cookie', cookie).expect(400);
    await request(app.getHttpServer())
      .get(`${WORK_ORDERS}/${String(ids.workOrder)}/daily-results`).set('Cookie', noPermCookie).expect(403);
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.createMany({ data: ['W-02-05', 'W-02-08'].map((permission_code) => ({ role_id: ids.role, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;
    const noPerm = await prisma.app_user.create({ data: { login_id: `${PREFIX}-NOPERM`, user_name: `${PREFIX}-NOPERM`, status_code: 'EMPLOYED' } });
    noPermCookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(noPerm.app_user_id), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX,
    } });
    ids.plant = (await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P1`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.night = (await prisma.shift.create({ data: {
      plant_id: ids.plant, shift_code: `${PREFIX}-N`, shift_name: `${PREFIX} 야간`,
      start_time: new Date('1970-01-01T20:00:00.000Z'), end_time: new Date('1970-01-01T08:00:00.000Z'), crosses_midnight: true,
    } })).shift_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    ids.item = (await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom, lot_controlled: true,
    } })).item_id;
    const processId = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } }))
      .process_id;
    const lineId = (await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LINE`, line_name: PREFIX } }))
      .production_line_id;
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operationId = (await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: processId, operation_name: PREFIX,
    } })).routing_operation_id;
    const workerId = (await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: PREFIX, business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED',
    } })).worker_id;
    const terminalId = (await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING',
    } })).terminal_id;

    const workOrder = (key: string) => prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, routing_operation_id: operationId, item_id: ids.item, order_qty: 20, uom_id: ids.uom,
      status_code: 'IN_PROGRESS', production_line_id: lineId, released_at: local('2026-10-21T19:00:00'),
    } });
    ids.workOrder = (await workOrder('A')).work_order_id;
    ids.emptyWorkOrder = (await workOrder('EMPTY')).work_order_id;
    const sessionId = (await prisma.work_session.create({ data: {
      work_order_id: ids.workOrder, session_no: 1, shift_id: ids.night, terminal_id: terminalId,
      started_at: local('2026-10-21T20:00:00'), status_code: 'RUNNING', idempotency_key: `${PREFIX}-WS-1`,
    } })).work_session_id;

    let sequence = 0;
    const result = async (at: string, good: number, data: { work_session_id?: bigint; corrects_production_result_id?: bigint; defect_qty?: number; scrap_qty?: number } = {}) => {
      sequence += 1;
      const key = `${PREFIX}-PR-${String(sequence)}`;
      return (await prisma.production_result.create({ data: {
        production_result_no: key, work_order_id: ids.workOrder, result_sequence: sequence, good_qty: good, uom_id: ids.uom,
        result_source_code: 'MANUAL', occurred_at: local(at), worker_id: workerId, status_code: 'CONFIRMED', idempotency_key: key, ...data,
      } })).production_result_id;
    };
    await result('2026-10-21T23:00:00', 5, { work_session_id: sessionId, defect_qty: 1, scrap_qty: 2 });
    const corrected = await result('2026-10-22T02:00:00', 3, { work_session_id: sessionId });
    await result('2026-10-22T02:00:00', 4, { work_session_id: sessionId, corrects_production_result_id: corrected });
    // 야간 세션을 닫지 않은 채 다음 날 낮에 넣은 실적 — 이 공장에는 야간만 있어 교대 없음이다.
    await result('2026-10-22T10:00:00', 2, { work_session_id: sessionId });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM production.production_result WHERE work_order_id IN (${workOrders}) AND corrects_production_result_id IS NOT NULL`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_session WHERE work_order_id IN (${workOrders})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: users.map((row) => row.app_user_id) } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
