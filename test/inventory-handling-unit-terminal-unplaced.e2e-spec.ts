/**
 * 창고·위치 없이 단말이 만든 포장의 공장 판정(omf-all-around#57).
 *
 * POP 포장 작업(P-02-08)은 `POST /inventory/handling-units` 에 창고·위치를 싣지 않는다. 판정이
 * 창고·위치만 보던 때는 그 포장이 어느 공장에도 속하지 않아 `:pack` 이 401 이었고, 모바일
 * 번호 검색(M-04-04·M-04-03)에서도 빠졌고, 포장 라벨 발행(`/app/document-issues`)도 401 이었다.
 * 요청은 화면이 보내는 모양 그대로다.
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

const PREFIX = 'HUUNPLE2E';
const PATH = '/api/inventory/handling-units';

interface TerminalSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
}

describe('창고 없이 단말이 만든 포장 (omf-all-around#57 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pop: TerminalSession;
  let mobile: TerminalSession;
  let foreign: TerminalSession;
  const keys: string[] = [];
  const ids = { item: 0, lot: 0, uom: 0, unit: 0, unitNo: '' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixture();

    const created = await as(pop, request(app.getHttpServer()).post(PATH))
      .set('Idempotency-Key', key())
      .send({ handlingUnitTypeCode: 'BOX', parentHandlingUnitId: null });
    expect(created.status).toBe(201);
    ids.unit = created.body.handlingUnit.handlingUnitId;
    ids.unitNo = created.body.handlingUnit.handlingUnitNo;
    expect(created.body.handlingUnit).toMatchObject({ warehouseId: null, locationId: null });
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('모바일 번호 검색에 같은 공장 단말이 만든 포장이 선다 — 남의 공장에는 안 선다', async () => {
    const own = await as(mobile, request(app.getHttpServer()).get(PATH)).query({ q: ids.unitNo });
    expect(own.status).toBe(200);
    expect(own.body.items.map((row: { handlingUnitId: number }) => row.handlingUnitId)).toEqual([ids.unit]);

    const other = await as(foreign, request(app.getHttpServer()).get(PATH)).query({ q: ids.unitNo });
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
  });

  it('단건·내용물 조회 — 같은 공장은 200, 남의 공장은 401', async () => {
    for (const suffix of ['', '/contents']) {
      const own = await as(mobile, request(app.getHttpServer()).get(`${PATH}/${ids.unit}${suffix}`));
      expect(own.status).toBe(200);
      const other = await as(foreign, request(app.getHttpServer()).get(`${PATH}/${ids.unit}${suffix}`));
      expect(other.status).toBe(401);
    }
  });

  it('포장 확정 — 남의 공장 단말은 401, 만든 공장 단말은 PACKED 로 닫는다', async () => {
    const body = {
      contents: [{ itemId: ids.item, lotId: ids.lot, qty: 10, uomId: ids.uom }],
      businessDate: '2026-09-22',
      occurredAt: '2026-09-22T10:00:00+07:00',
    };
    const other = await as(foreign, request(app.getHttpServer()).post(`${PATH}/${ids.unit}:pack`))
      .set('Idempotency-Key', key()).send(body);
    expect(other.status).toBe(401);

    const packed = await as(pop, request(app.getHttpServer()).post(`${PATH}/${ids.unit}:pack`))
      .set('Idempotency-Key', key()).send(body);
    expect(packed.status).toBe(200);
    expect(packed.body.handlingUnit).toMatchObject({ handlingUnitId: ids.unit, statusCode: 'PACKED' });
    expect(packed.body.contents).toHaveLength(1);
  });

  it('포장 라벨 발행 — 남의 공장 단말은 401, 만든 공장 단말은 201', async () => {
    const body = {
      documentTypeCode: 'PACKING_LABEL',
      targets: [{ targetTypeCode: 'HANDLING_UNIT', targetId: ids.unit }],
    };
    const other = await as(foreign, request(app.getHttpServer()).post('/api/app/document-issues'))
      .set('Idempotency-Key', key()).send(body);
    expect(other.status).toBe(401);

    const issued = await as(pop, request(app.getHttpServer()).post('/api/app/document-issues'))
      .set('Idempotency-Key', key()).send(body);
    expect(issued.status).toBe(201);
    expect(issued.body.items).toHaveLength(1);
    expect(issued.body.items[0]).toMatchObject({ documentTypeCode: 'PACKING_LABEL' });
    expect(await prisma.document_issue_log.count({ where: {
      document_type_code: 'PACKING_LABEL', target_type_code: 'HANDLING_UNIT', target_id: ids.unit, terminal_id: pop.terminalId,
    } })).toBe(1);
  });

  function as(session: TerminalSession, test: request.Test): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  function key(): string {
    const value = randomUUID();
    keys.push(value);
    return value;
  }

  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '미배치포장검사법인',
      country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id,
      business_unit_code: `${PREFIX}-BU`, business_unit_name: '미배치포장검사사업부',
    } });
    const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
    ids.uom = Number(uom.uom_id);
    const sessions: TerminalSession[] = [];
    for (const [code, type] of [['P1', 'POP'], ['P1M', 'MOBILE'], ['P2', 'POP']] as const) {
      const plantCode = `${PREFIX}-${code === 'P2' ? 'P2' : 'P1'}`;
      const plant = await prisma.plant.findFirst({ where: { plant_code: plantCode } })
        ?? await prisma.plant.create({ data: {
          legal_entity_id: entity.legal_entity_id, plant_code: plantCode,
          plant_name: `미배치포장검사공장${plantCode}`, timezone_code: 'Asia/Ho_Chi_Minh',
        } });
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-T-${code}`, plant_id: plant.plant_id,
        terminal_type_code: type, status_code: 'RUNNING',
      } });
      const worker = await prisma.worker.create({ data: {
        worker_no: `${PREFIX}-W-${code}`, worker_name: `미배치포장검사작업자${code}`,
        business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED',
      } });
      sessions.push({
        terminalId: terminal.terminal_id,
        workerNo: worker.worker_no,
        token: app.get(JwtService).sign({
          sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
          terminalCode: terminal.terminal_code, plantId: Number(plant.plant_id),
        }),
      });
      if (code === 'P1') {
        const item = await prisma.item.create({ data: {
          item_code: `${PREFIX}-IT`, item_name: '미배치포장검사품목', item_type_code: 'FINISHED_GOOD',
          base_uom_id: uom.uom_id, lot_controlled: true,
        } });
        ids.item = Number(item.item_id);
        ids.lot = Number((await prisma.lot.create({ data: {
          lot_no: `${PREFIX}-LOT`, item_id: item.item_id, lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id, initial_qty: 100, uom_id: uom.uom_id,
          source_type_code: 'PRODUCTION_RESULT', source_id: 1, status_code: 'AVAILABLE',
        } })).lot_id);
      }
    }
    [pop, mobile, foreign] = sessions;
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({ where: { idempotency_key: { in: keys } } });
    const terminalIds = (await prisma.terminal.findMany({
      where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true },
    })).map((row) => row.terminal_id);
    const unitIds = (await prisma.audit_event.findMany({
      where: { terminal_id: { in: terminalIds }, target_type_code: 'HANDLING_UNIT' },
      select: { target_id: true },
    })).map((row) => row.target_id);
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.document_issue_log.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.handling_unit_content.deleteMany({ where: { handling_unit_id: { in: unitIds } } });
    await prisma.handling_unit.deleteMany({ where: { handling_unit_id: { in: unitIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
