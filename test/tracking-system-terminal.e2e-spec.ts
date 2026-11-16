/**
 * 추적 시스템 연동 단말(TRACKING_SYSTEM · flowtrack 연동 제안 §3-1·3-2) (e2e).
 *
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'TRKSYS';

describe('추적 시스템 연동 단말 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

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

  // 열린 W/O 만이 아니다 — 닫힌 W/O 도 받아 flowtrack 이 투입을 막는다. 공정 매핑이 없어도 읽는다.
  it('자기 공장 W/O 를 상태·공정 매핑과 상관없이 읽고, 남의 공장 W/O 는 읽지 않는다', async () => {
    const response = await get('/production/work-orders', { q: PREFIX, size: 200 }).expect(200);

    expect(response.body.items.map((row: { workOrderNo: string }) => row.workOrderNo).sort())
      .toEqual([`${PREFIX}-WO-OPEN`, `${PREFIX}-WO-PLANNED`]);
  });

  it('마감 사유 공통코드를 읽는다', async () => {
    const response = await get('/mdm/code-values', { codeGroupCode: 'WORK_ORDER_COMPLETION_VARIANCE_REASON', size: 200 }).expect(200);

    expect(response.body.items.map((row: { code: string }) => row.code)).toEqual(expect.arrayContaining(['PLAN_CHANGE', 'OTHER']));
  });

  it('POP 전용 읽기는 401 이고 지금 단말을 「추적 시스템 연동」으로 알린다', async () => {
    const response = await get('/production/work-sessions').expect(401);

    expect(response.body.errors[0].message).toContain('(지금 단말: 추적 시스템 연동)');
  });

  async function fixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const plant = async (code: string) => (await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    const own = await plant('P1');
    const other = await plant('P2');

    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    const item = await prisma.item.create({ data: {
      item_code: `${PREFIX}-ITEM`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id,
    } });
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: PREFIX, process_type_code: 'ASSEMBLY' } });
    const routing = await prisma.routing.create({ data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: PREFIX,
    } });
    const line = async (code: string, plantId: bigint) => (await prisma.production_line.create({ data: {
      plant_id: plantId, line_code: `${PREFIX}-${code}`, line_name: PREFIX,
    } })).production_line_id;
    const ownLine = await line('L1', own);
    const otherLine = await line('L2', other);

    const workOrder = (code: string, lineId: bigint, status: string, releasedAt: Date | null) => prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${code}`, routing_operation_id: operation.routing_operation_id, item_id: item.item_id, order_qty: 10,
      uom_id: uom.uom_id, status_code: status, production_line_id: lineId, released_at: releasedAt,
    } });
    await workOrder('OPEN', ownLine, 'RELEASED', new Date('2026-11-16T01:00:00.000Z'));
    await workOrder('PLANNED', ownLine, 'PLANNED', null);
    await workOrder('FOREIGN', otherLine, 'RELEASED', new Date('2026-11-16T01:00:00.000Z'));

    const terminal = await prisma.terminal.create({ data: {
      terminal_code: `${PREFIX}-FT`, plant_id: own, terminal_type_code: 'TRACKING_SYSTEM', status_code: 'RUNNING',
    } });
    token = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(own),
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
