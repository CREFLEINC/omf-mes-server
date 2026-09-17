/**
 * P-06-01(창고 적재 위치 라벨 발행)이 부르는 경로를 POP 단말 세션(토큰 + `X-Worker-No`)으로 탄다(장부 P-28).
 *
 * ⛔ 설계에 없는 화면이다 — W-06-07(창고·Location 마스터) §3 은 「POP 인쇄 화면은 신설하지 않는다」.
 * 그래서 이 파일이 지키는 것은 계약이 아니라 «서버가 먼저 연 단말 범위»다: 창고·위치 목록(전에는
 * MOBILE 전용)과 위치 라벨 렌디션(전에는 단말 허용 출력물에 없었다). 남의 공장은 둘 다 막힌다.
 * ⚠ 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'POPLOCE2E';

interface PopSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
}

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('POP 창고 적재 위치 라벨 (장부 P-28 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let own: PopSession;
  let foreign: PopSession;
  const keys: string[] = [];
  /** 자기 공장 위치는 [활성, 비활성, 발행용] — 화면이 `includeInactive=true` 로 비활성까지 받는다. */
  const ids = { warehouse: 0n, foreignWarehouse: 0n, locations: [] as bigint[], foreignLocation: 0n };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixture();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ POP 단말은 자기 공장 창고만 목록으로 받는다', async () => {
    const response = await asPop(get('/api/mdm/warehouses', { includeInactive: 'false', size: 100 }), own)
      .expect(200);

    const validate = validator('GET /mdm/warehouses');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 공장 좁힘은 컨트롤러가 단말 컨텍스트로 건다 — 남의 공장 창고가 새지 않는다.
    expect(response.body.items.map((row: { warehouseId: number }) => row.warehouseId))
      .toEqual([Number(ids.warehouse)]);
  });

  it('⭐ POP 단말은 자기 공장 창고의 위치 목록을 받는다', async () => {
    const query = { warehouseId: String(ids.warehouse), includeInactive: 'true', page: 1, size: 50 };
    const response = await asPop(get('/api/mdm/locations', query), own).expect(200);

    const validate = validator('GET /mdm/locations');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items.map((row: { locationId: number }) => row.locationId).sort())
      .toEqual(ids.locations.map(Number).sort());
    expect(response.body.page).toMatchObject({ page: 1, size: 50, total: ids.locations.length });
  });

  it('⛔ POP 단말이 남의 공장 창고의 위치를 물으면 401 이다', async () => {
    const query = { warehouseId: String(ids.foreignWarehouse), includeInactive: 'true' };
    await asPop(get('/api/mdm/locations', query), own).expect(401);
  });

  it('⭐ POP 단말이 위치 라벨을 발행하고 tspl 렌디션을 받는다', async () => {
    const locationId = ids.locations[2];

    // 화면은 위치 라벨을 지원하는 매핑만 프린터로 고른다.
    const printers = await asPop(get('/api/app/printers', { documentTypeCode: 'LOCATION_LABEL' }), own)
      .expect(200);
    expect(printers.body.items.map((row: { printerName: string }) => row.printerName))
      .toEqual([`${PREFIX}-PRN`]);

    const issued = await issueLabel(own, locationId).expect(201);
    expect(issued.body.issuedCount).toBe(1);
    expect(issued.body.items[0]).toMatchObject({
      documentTypeCode: 'LOCATION_LABEL', issueSeq: 1, issuedBy: null, printOutcome: 'PENDING',
      terminalId: Number(own.terminalId),
      target: { targetTypeCode: 'LOCATION', targetId: Number(locationId) },
    });
    const logId: number = issued.body.items[0].documentIssueLogId;

    const summary = await asPop(get('/api/app/document-issues/summary', {
      targetTypeCode: 'LOCATION', targetIds: String(locationId), documentTypeCode: 'LOCATION_LABEL',
    }), own).expect(200);
    expect(summary.body.items).toEqual([
      expect.objectContaining({ targetId: Number(locationId), issueCount: 1, lastIssueSeq: 1 }),
    ]);
    const history = await asPop(get('/api/app/document-issues', {
      targetTypeCode: 'LOCATION', targetId: String(locationId),
    }), own).expect(200);
    expect(history.body.items.map((row: { documentIssueLogId: number }) => row.documentIssueLogId))
      .toEqual([logId]);

    const rendition = await renditionTspl(own, logId)
      .expect(200)
      .expect('Content-Type', /application\/vnd\.tspl/);
    const text = (rendition.body as Buffer).toString('utf8');
    expect(text.startsWith('SIZE ')).toBe(true);
    const qr = text.split('\r\n').find((line) => line.startsWith('QRCODE '));
    expect(qr?.endsWith(`,"${PREFIX}-LOC-2"`)).toBe(true);

    const reported = await asPop(request(app.getHttpServer())
      .post(`/api/app/document-issues/${String(logId)}:report-print`)
      .set('Idempotency-Key', newKey())
      .send({ outcome: 'SUCCEEDED' }), own).expect(200);
    expect(reported.body).toMatchObject({ documentIssueLogId: logId, printOutcome: 'SUCCEEDED' });
  });

  it('⛔ POP 단말은 남의 공장 위치 라벨의 렌디션을 받지 못한다 — 401', async () => {
    // 남의 공장 단말은 제 위치 라벨을 발행하고 받는다 — 출력물 종류로 막는 것이 아니다.
    const issued = await issueLabel(foreign, ids.foreignLocation).expect(201);
    const logId: number = issued.body.items[0].documentIssueLogId;
    await renditionTspl(foreign, logId).expect(200);

    await renditionTspl(own, logId).expect(401);
    // 발행 쪽도 같은 축이다 — 남의 공장 위치에는 라벨을 낼 수 없다.
    await issueLabel(own, ids.foreignLocation).expect(401);
    expect(await prisma.document_issue_log.count({
      where: { target_type_code: 'LOCATION', target_id: ids.foreignLocation },
    })).toBe(1);
  });

  it('⭐ 공정 매핑이 없는 POP 단말에도 접근 화면에 P-06-01 이 담긴다', async () => {
    expect(await prisma.terminal_process.count({ where: { terminal_id: own.terminalId } })).toBe(0);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${String(own.terminalId)}/accessible-screens`)
      .set('Authorization', `Bearer ${own.token}`)
      .expect(200);

    expect(response.body.screenCodes).toContain('P-06-01');
  });

  // ── 헬퍼 ────────────────────────────────────────────────────────────────

  function get(path: string, query: Record<string, string | number>): request.Test {
    return request(app.getHttpServer()).get(path).query(query);
  }

  function asPop(test: request.Test, session: PopSession): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  function issueLabel(session: PopSession, locationId: bigint): request.Test {
    return asPop(request(app.getHttpServer())
      .post('/api/app/document-issues')
      .set('Idempotency-Key', newKey())
      .send({
        documentTypeCode: 'LOCATION_LABEL',
        targets: [{ targetTypeCode: 'LOCATION', targetId: Number(locationId) }],
        remarks: `${PREFIX} 위치 라벨`,
      }), session);
  }

  function renditionTspl(session: PopSession, logId: number): request.Test {
    return asPop(get(`/api/app/document-issues/${String(logId)}/rendition`, { format: 'tspl' })
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      }), session);
  }

  function newKey(): string {
    const key = randomUUID();
    keys.push(key);
    return key;
  }

  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '위치라벨검사법인',
      country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id,
      business_unit_code: `${PREFIX}-BU`, business_unit_name: '위치라벨검사사업부',
    } });
    const sessions: PopSession[] = [];
    const warehouses: bigint[] = [];
    for (const code of ['P1', 'P2']) {
      const plant = await prisma.plant.create({ data: {
        legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`,
        plant_name: `위치라벨검사공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh',
      } });
      warehouses.push((await prisma.warehouse.create({ data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH-${code}`, warehouse_name: `위치라벨검사창고${code}`,
        warehouse_type_code: 'RAW_MATERIAL', management_level_code: 'LOCATION',
      } })).warehouse_id);
      // ⛔ 공정 매핑(`terminal_process`)을 두지 않는다 — 「매핑이 없어도 화면이 나온다」가 시험 대상이다.
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-POP-${code}`, plant_id: plant.plant_id,
        terminal_type_code: 'POP', status_code: 'RUNNING',
      } });
      const worker = await prisma.worker.create({ data: {
        worker_no: `${PREFIX}-W-${code}`, worker_name: `위치라벨검사작업자${code}`,
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
      if (code === 'P1') await mapPrinters(plant.plant_id, terminal.terminal_id);
    }
    [own, foreign] = sessions;
    [ids.warehouse, ids.foreignWarehouse] = warehouses;

    for (const [index, active] of [[0, true], [1, false], [2, true]] as const) {
      ids.locations.push((await prisma.location.create({ data: {
        warehouse_id: ids.warehouse, location_code: `${PREFIX}-LOC-${index}`,
        location_name: `LOC ${index}`, location_type_code: 'STORAGE', is_active: active,
      } })).location_id);
    }
    ids.foreignLocation = (await prisma.location.create({ data: {
      warehouse_id: ids.foreignWarehouse, location_code: `${PREFIX}-LOC-X`,
      location_name: 'LOC X', location_type_code: 'STORAGE',
    } })).location_id;
  }

  /** 위치 라벨 프린터 하나와, 걸러져야 할 자재 라벨 프린터 하나. */
  async function mapPrinters(plantId: bigint, terminalId: bigint): Promise<void> {
    for (const [suffix, documentType, isDefault] of [
      ['', 'LOCATION_LABEL', true],
      ['-LOT', 'MATERIAL_LOT_LABEL', false],
    ] as const) {
      const printer = await prisma.printer.create({ data: {
        plant_id: plantId, printer_code: `${PREFIX}-PRN${suffix}`,
        printer_name: `위치라벨검사프린터${suffix}`, printer_type_code: 'LABEL',
        connection_uri: `mock://pop-location-label${suffix}`, status_code: 'READY',
      } });
      await prisma.terminal_printer.create({ data: {
        terminal_id: terminalId, printer_id: printer.printer_id,
        is_default: isDefault, supported_document_type_codes: [documentType],
      } });
    }
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({ where: { idempotency_key: { in: keys } } });
    const terminalIds = (await prisma.terminal.findMany({
      where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true },
    })).map((row) => row.terminal_id);
    const locationIds = (await prisma.location.findMany({
      where: { location_code: { startsWith: PREFIX } }, select: { location_id: true },
    })).map((row) => row.location_id);
    // ⛔ 단말 쓰기는 감사 행을 남기고 그 행이 단말을 FK 로 문다 — 단말보다 먼저 지운다.
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    // ⛔ 발행 로그는 대상에 FK 가 없다(다형) — 위치를 지우기 «전»에 손으로 지운다.
    await prisma.document_issue_log.deleteMany({ where: { OR: [
      { terminal_id: { in: terminalIds } },
      { target_type_code: 'LOCATION', target_id: { in: locationIds } },
    ] } });
    await prisma.terminal_printer.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.printer.deleteMany({ where: { printer_code: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_id: { in: locationIds } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
