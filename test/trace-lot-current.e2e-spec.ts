/**
 * 현재 생산 LOT — `GET /trace/lots?workOrderId=&currentOnly=true`(장부 P-103) (e2e).
 *
 * 그 W/O 의 완료·폐번되지 않은 생산 LOT 중 진행 중이 먼저, 그 안에서 회차가 가장 앞선 한 건이다.
 * 선발행 LOT 이 여럿인 W/O 에서 POP 이 앞 LOT 을 완료한 뒤 다음 LOT 으로 넘어가는 축이다.
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'CURLOT';
const LOTS = '/api/trace/lots';
const RELEASED_AT = new Date('2026-10-22T01:00:00.000Z');

describe('현재 생산 LOT 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let token: string;
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

  it('currentOnly 는 그 W/O 의 미완료 생산 LOT 중 진행 중인 것을 우선해 한 건만 낸다', async () => {
    const workOrderId = await workOrderWith('A', [['WAITING', 1], ['ACTIVE', 2], ['WAITING', 3]]);

    const response = await current(workOrderId).expect(200);

    expect(response.body.items.map((row: { lotNo: string }) => row.lotNo)).toEqual([`${PREFIX}-A-2`]);
    expect(response.body.page.total).toBe(1);
  });

  it('진행 중이 없으면 회차가 가장 앞선 대기 LOT 을 낸다', async () => {
    const workOrderId = await workOrderWith('B', [['WAITING', 2], ['WAITING', 1]]);

    expect(lotNos(await current(workOrderId).expect(200))).toEqual([`${PREFIX}-B-1`]);
  });

  it('완료·폐번 LOT 은 건너뛴다 — 앞 LOT 을 완료하면 다음 LOT 이 현재가 된다', async () => {
    const workOrderId = await workOrderWith('C', [['VOIDED', 1], ['ACTIVE', 2], ['WAITING', 3]]);
    expect(lotNos(await current(workOrderId).expect(200))).toEqual([`${PREFIX}-C-2`]);

    await prisma.lot.updateMany({ where: { lot_no: `${PREFIX}-C-2` }, data: { completed_at: new Date() } });

    expect(lotNos(await current(workOrderId).expect(200))).toEqual([`${PREFIX}-C-3`]);
  });

  it('미완료 LOT 이 없으면 빈 목록', async () => {
    const workOrderId = await workOrderWith('D', [['ACTIVE', 1]]);
    await prisma.lot.updateMany({ where: { lot_no: `${PREFIX}-D-1` }, data: { completed_at: new Date() } });

    const response = await current(workOrderId).expect(200);

    expect(response.body.items).toEqual([]);
    expect(response.body.page.total).toBe(0);
  });

  it('currentOnly 에 workOrderId 가 없으면 400', async () => {
    const response = await request(app.getHttpServer()).get(`${LOTS}?currentOnly=true`).set('Cookie', cookie).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'workOrderId', code: 'REQUIRED' });
  });

  it('POP 단말 토큰으로 자기 W/O 의 현재 LOT 을 읽는다', async () => {
    const workOrderId = await workOrderWith('E', [['WAITING', 1], ['WAITING', 2]]);

    const response = await request(app.getHttpServer())
      .get(LOTS)
      .query({ workOrderId: String(workOrderId), currentOnly: 'true' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(lotNos(response)).toEqual([`${PREFIX}-E-1`]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function current(workOrderId: bigint): request.Test {
    return request(app.getHttpServer())
      .get(LOTS)
      .query({ workOrderId: String(workOrderId), currentOnly: 'true' })
      .set('Cookie', cookie);
  }

  function lotNos(response: request.Response): string[] {
    return response.body.items.map((row: { lotNo: string }) => row.lotNo);
  }

  /** 선발행 LOT 을 [생명주기, 회차] 로 심은 W/O. LOT 번호는 `${PREFIX}-{key}-{회차}` 다. */
  async function workOrderWith(key: string, lots: [string, number][]): Promise<bigint> {
    const workOrderId = (await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, routing_operation_id: ids.operation, item_id: ids.item, order_qty: 100,
      uom_id: ids.uom, status_code: 'RELEASED', production_line_id: ids.line, released_at: RELEASED_AT,
    } })).work_order_id;
    for (const [lifecycle, seq] of lots) {
      await prisma.lot.create({ data: {
        lot_no: `${PREFIX}-${key}-${seq}`, item_id: ids.item, lot_type_code: 'PRODUCTION', plant_id: ids.plant,
        initial_qty: 50, uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrderId,
        status_code: 'INSPECTION_PENDING', lifecycle_status_code: lifecycle, work_order_lot_seq: seq,
      } });
    }
    return workOrderId;
  }

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-02-05' } });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
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

    const terminal = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING',
    } });
    // 단말이 W/O 를 읽으려면 W/O 공정에서 작업을 시작할 수 있어야 한다(`terminal-read-policy.ts`).
    await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: ids.process, can_start_work: true } });
    token = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-` } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: users.map((row) => row.app_user_id) } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
