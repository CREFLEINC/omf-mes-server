/**
 * POP 의 옆 설비 — 같은 공장의 가동 설비 목록·그 설비의 W/O 목록·점검 항목 읽기와 그 설비로 작업 시작(장부 P-123) (e2e).
 *
 * 다른 공장 설비·없는 설비·비가동 설비는 같은 401 이다(있는지 드러내지 않는다).
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

const PREFIX = 'POPEQRD';

describe('POP 옆 설비 읽기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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

  const get = (path: string, query: Record<string, unknown> = {}) =>
    request(app.getHttpServer()).get(`/api${path}`).query(query).set('Authorization', `Bearer ${token}`);

  it('POP 이 같은 공장의 가동·활성 설비 목록을 읽는다 — 공장·상태는 단말 기준으로 덮어쓴다', async () => {
    const response = await get('/mdm/equipments', { statusCode: 'RETIRED', size: 100 }).expect(200);

    const codes = (response.body.items as { equipmentCode: string }[]).map((item) => item.equipmentCode).filter((code) => code.startsWith(PREFIX));
    expect(codes.sort()).toEqual([`${PREFIX}-E1`, `${PREFIX}-E2`]);
  });

  it('다른 공장을 걸어 설비 목록을 읽으면 401 이다', async () => {
    await get('/mdm/equipments', { plantId: Number(ids.otherPlant) }).expect(401);
  });

  it('같은 공장 옆 설비로 W/O 목록을 읽는다', async () => {
    const response = await get('/production/work-orders', { open: 'true', plannedEquipmentId: Number(ids.e2), size: 100 }).expect(200);

    const numbers = (response.body.items as { workOrderNo: string }[]).map((item) => item.workOrderNo);
    expect(numbers).toEqual([`${PREFIX}-WO-E2`]);
  });

  it('다른 공장 설비·없는 설비로 W/O 목록을 읽으면 같은 401 이다', async () => {
    const foreign = await get('/production/work-orders', { open: 'true', plannedEquipmentId: Number(ids.foreign) }).expect(401);
    const missing = await get('/production/work-orders', { open: 'true', plannedEquipmentId: 999_999_999 }).expect(401);

    expect(foreign.body).toEqual(missing.body);
  });

  const start = (equipmentId: bigint) =>
    request(app.getHttpServer()).post('/api/production/work-sessions')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).set('X-Worker-No', `${PREFIX}-W1`)
      .send({ workOrderId: Number(ids.woE2), equipmentId: Number(equipmentId), startedAt: '2026-10-26T02:00:00.000Z' });

  it('설비 붙은 POP 이 옆 설비의 점검 항목을 읽는다 — 다른 공장·비가동 설비는 401', async () => {
    await get(`/mdm/equipments/${ids.e2}/inspection-items`).expect(200);
    await get(`/mdm/equipments/${ids.foreign}/inspection-items`).expect(401);
    await get(`/mdm/equipments/${ids.retired}/inspection-items`).expect(401);
    await get(`/mdm/equipments/${ids.inactive}/inspection-items`).expect(401);
  });

  it('설비 붙은 POP 이 옆 설비로 작업을 시작한다 — 다른 공장·비가동·없는 설비는 같은 401 이고 문구에 조치가 있다', async () => {
    const foreign = await start(ids.foreign).expect(401);
    const retired = await start(ids.retired).expect(401);
    const missing = await start(999_999_999n).expect(401);
    // IN_SERVICE 지만 비활성 — 단말 설비 목록에 안 보이는 설비라 시작도 막는다.
    const inactive = await start(ids.inactive).expect(401);
    expect(inactive.body).toEqual(foreign.body);
    expect(retired.body).toEqual(foreign.body);
    expect(missing.body).toEqual(foreign.body);
    expect(foreign.body.errors[0].message).toContain('가동 중(IN_SERVICE) 설비만');

    const started = await start(ids.e2).expect(201);
    // 세션에는 실은 설비가 남는다 — 단말 설비(E1)와 다르다.
    expect(started.body).toMatchObject({ equipmentId: Number(ids.e2), terminalId: Number(ids.terminal) });
  });

  // 맞지 않는 단말 유형 — 「로그인이 필요합니다」가 아니라 맞는 단말·화면을 알린다(상태는 401 그대로).
  it('POP 단말로 PDA 전용 경로(상자 구성 정정)를 부르면 401 이고 PDA 화면을 안내한다', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/inventory/handling-units/1/contents')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).set('X-Worker-No', `${PREFIX}-W1`)
      .send({ items: [] })
      .expect(401);

    expect(response.body.errors[0].message)
      .toBe('이 기능은 PDA(모바일 단말)에서만 쓸 수 있습니다(지금 단말: POP 단말) — PDA(모바일 단말) 포장 재구성 스캔(M-04-03)에서 하세요.');
  });

  async function fixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const plant = (code: string) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant = (await plant('P1')).plant_id;
    ids.otherPlant = (await plant('P2')).plant_id;
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX,
    } });
    await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: PREFIX, business_unit_id: unit.business_unit_id, plant_id: ids.plant, status_code: 'EMPLOYED',
    } });
    const equipment = async (code: string, plantId: bigint, status = 'IN_SERVICE', active = true) => (await prisma.equipment.create({ data: {
      plant_id: plantId, equipment_code: `${PREFIX}-${code}`, equipment_name: PREFIX, equipment_type_code: 'MACHINE', status_code: status,
      is_active: active,
    } })).equipment_id;
    ids.e1 = await equipment('E1', ids.plant);
    ids.e2 = await equipment('E2', ids.plant);
    ids.retired = await equipment('E3', ids.plant, 'RETIRED');
    ids.foreign = await equipment('E4', ids.otherPlant);
    ids.inactive = await equipment('E5', ids.plant, 'IN_SERVICE', false);

    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    const item = await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id,
    } });
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'PRODUCTION' } });
    const line = await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LINE`, line_name: PREFIX } });
    const routing = await prisma.routing.create({ data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX,
    } });
    for (const [key, equipmentId] of [['E1', ids.e1], ['E2', ids.e2]] as const) {
      ids[`wo${key}`] = (await prisma.work_order.create({ data: {
        work_order_no: `${PREFIX}-WO-${key}`, routing_operation_id: operation.routing_operation_id, item_id: item.item_id, order_qty: 10,
        uom_id: uom.uom_id, status_code: 'RELEASED', production_line_id: line.production_line_id, planned_equipment_id: equipmentId,
        released_at: new Date('2026-10-26T01:00:00.000Z'),
      } })).work_order_id;
    }

    const terminal = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-POP`, plant_id: ids.plant, terminal_type_code: 'POP', status_code: 'RUNNING', equipment_id: ids.e1,
    } });
    ids.terminal = terminal.terminal_id;
    await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: process.process_id, can_start_work: true } });
    token = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const workOrders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const table of ['work_session_event', 'work_session_worker']) {
      await prisma.$executeRawUnsafe(`DELETE FROM production.${table} WHERE work_session_id IN (
        SELECT work_session_id FROM production.work_session WHERE work_order_id IN (${workOrders}))`);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM production.work_session WHERE work_order_id IN (${workOrders})`);
    const terminals = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminals } } });
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminals } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminals } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
