/**
 * POP OQC 출하검사 판정(P-04-06 · omf-all-around#109 · 장부 P-80) — POP 단말(토큰 + `X-Worker-No`)이 쓰는 경로 (e2e).
 *
 * OQC 의뢰는 W/O 가 없어(출하지시 대상 · `work_order_id` null) 공정 매핑 축 대신 «단말과 같은 공장»으로 연다 —
 * ⓐ 의뢰 LOT 의 공장 ⓑ 출하지시의 출하 공장. ⛔ 출하 공장이 비어 있는 지시의 의뢰는 열지 않는다.
 * 목록·상세·회차 조회·판정 저장(확정으로 태어난다) 네 자리의 허용/거부 경계를 본다.
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

const PREFIX = 'OQCPOP';
const ITEM_CODE = `${PREFIX}-ITEM`;
const INSPECTED_AT = '2026-10-20T04:00:00.000Z';

interface PopSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
  workerId: bigint;
  plantId: bigint;
}

describe('POP OQC 출하검사 판정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let own: PopSession;
  let foreign: PopSession;
  const keys: string[] = [];
  const ids = {
    uom: 0n, item: 0n,
    /** 출하 공장 = 단말 공장인 지시의 의뢰 — 판정 저장 대상. */
    ownShipment: 0n,
    /** 출하 공장 = 단말 공장 — 조회만 하는 둘째 의뢰. */
    ownShipmentRead: 0n,
    /** 출하 공장이 비었지만 LOT 이 단말 공장의 것. */
    ownLot: 0n,
    /** 남의 공장 출하지시의 의뢰. */
    foreignShipment: 0n,
    /** 출하 공장이 빈 지시의 의뢰(LOT 없음). */
    noPlant: 0n,
    /** 같은 공장이지만 이미 끝난 의뢰 — 판정 대기 목록에 없다. */
    completed: 0n,
  };

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

  it('⭐ 판정 대기 목록 — W/O 없이 inspectionTypeCode=OQC 로 같은 공장 의뢰만 온다(출하 공장 또는 LOT 공장)', async () => {
    const response = await asPop(request(app.getHttpServer())
      .get('/api/quality/inspection-requests')
      .query({ inspectionTypeCode: 'OQC', pendingOnly: true, size: 100 }), own).expect(200);

    const listed = (response.body.items as { inspectionRequestId: number }[]).map((row) => BigInt(row.inspectionRequestId));
    expect(listed).toEqual(expect.arrayContaining([ids.ownShipment, ids.ownShipmentRead, ids.ownLot]));
    for (const hidden of [ids.foreignShipment, ids.noPlant, ids.completed]) expect(listed).not.toContain(hidden);
  });

  it('⛔ OQC 가 아닌 목록·유형 없는 목록은 여전히 W/O 를 요구한다 — 401', async () => {
    const list = (query: Record<string, unknown>) => asPop(request(app.getHttpServer())
      .get('/api/quality/inspection-requests').query(query), own);

    await list({ inspectionTypeCode: 'PQC' }).expect(401);
    await list({ pendingOnly: true }).expect(401);
  });

  it('⭐ 상세 — 같은 공장 의뢰는 200, 남의 공장·출하 공장 빈 의뢰는 401', async () => {
    const detail = (id: bigint) => asPop(request(app.getHttpServer())
      .get(`/api/quality/inspection-requests/${String(id)}`), own);

    expect((await detail(ids.ownShipment).expect(200)).body).toMatchObject({
      inspectionRequestId: Number(ids.ownShipment), inspectionTypeCode: 'OQC',
    });
    await detail(ids.ownLot).expect(200);
    await detail(ids.foreignShipment).expect(401);
    await detail(ids.noPlant).expect(401);
  });

  it('⭐ 회차 조회 — 볼 수 있는 의뢰 하나로만 열린다 · 의뢰 없이 훑기·남의 공장은 401', async () => {
    const rounds = (query: Record<string, unknown>) => asPop(request(app.getHttpServer())
      .get('/api/quality/inspection-results').query(query), own);

    expect((await rounds({ inspectionRequestId: Number(ids.ownShipment) }).expect(200)).body.items).toEqual([]);
    await rounds({}).expect(401);
    await rounds({ inspectionRequestId: Number(ids.foreignShipment) }).expect(401);
    await rounds({ inspectionRequestId: Number(ids.noPlant) }).expect(401);
  });

  it('⛔ 판정 저장 — 남의 공장·출하 공장 빈 의뢰, 남의 공장 사번은 401 이고 행이 남지 않는다', async () => {
    await save(ids.foreignShipment, own).expect(401);
    await save(ids.noPlant, own).expect(401);
    // 단말은 같은 공장이어도 사번이 남의 공장 작업자면 막는다(PQC 와 같은 규칙).
    await save(ids.ownShipment, { ...own, workerNo: foreign.workerNo }).expect(401);

    expect(await prisma.inspection_result.count({
      where: { inspection_request_id: { in: [ids.foreignShipment, ids.noPlant, ids.ownShipment] } },
    })).toBe(0);
  });

  it('⭐ 판정 저장 — 같은 공장 의뢰에 확정으로 남고, 검사자·단말이 차며 의뢰가 끝나 대기 목록에서 빠진다', async () => {
    const response = await save(ids.ownShipment, own).expect(201);

    expect(response.body).toMatchObject({ statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED', inspectionRound: 1 });
    const row = await prisma.inspection_result.findUniqueOrThrow({
      where: { inspection_result_id: BigInt(response.body.inspectionResultId) },
    });
    expect(row).toMatchObject({
      inspector_id: own.workerId, terminal_id: own.terminalId, created_by: null, status_code: 'CONFIRMED',
    });
    expect(row.confirmed_at).not.toBeNull();
    expect((await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: ids.ownShipment } })).status_code)
      .toBe('COMPLETED');

    const queue = await asPop(request(app.getHttpServer())
      .get('/api/quality/inspection-requests')
      .query({ inspectionTypeCode: 'OQC', pendingOnly: true, size: 100 }), own).expect(200);
    expect((queue.body.items as { inspectionRequestId: number }[]).map((item) => BigInt(item.inspectionRequestId)))
      .not.toContain(ids.ownShipment);

    // 저장 뒤 화면이 다시 읽는 회차 이력.
    const rounds = await asPop(request(app.getHttpServer())
      .get('/api/quality/inspection-results').query({ inspectionRequestId: Number(ids.ownShipment) }), own).expect(200);
    expect(rounds.body.items).toHaveLength(1);
  });

  it('⭐ 화면 이동 후보 — 검사 입력 공정 단말에만 P-04-06 이 열린다', async () => {
    const screens = async (session: PopSession) => (await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${String(session.terminalId)}/accessible-screens`)
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200)).body.screenCodes as string[];

    expect(await screens(own)).toContain('P-04-06');
    expect(await screens(foreign)).not.toContain('P-04-06');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function asPop(test: request.Test, session: PopSession): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  function save(inspectionRequestId: bigint, session: PopSession): request.Test {
    const key = randomUUID();
    keys.push(key);
    return asPop(request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Idempotency-Key', key)
      .send({
        inspectionRequestId: Number(inspectionRequestId), inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0,
        uomId: Number(ids.uom), inspectedAt: INSPECTED_AT, statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED',
      }), session);
  }

  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'OQC단말법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'OQC단말사업부',
    } });
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    ids.item = (await prisma.item.create({ data: {
      item_code: ITEM_CODE, item_name: 'OQC단말품목', item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id, lot_controlled: true,
    } })).item_id;
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: 'OQC검사공정', process_type_code: 'INSPECTION' } });
    const customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-C`, partner_name: 'OQC단말고객' } })).partner_id;

    const sessions: PopSession[] = [];
    for (const code of ['P1', 'P2']) {
      const plant = await prisma.plant.create({ data: {
        legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: `OQC단말공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh',
      } });
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-POP-${code}`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING',
      } });
      // ⭐ 자기 공장 단말만 검사 입력 공정에 붙인다 — 남의 공장 단말은 매핑 0행이다(화면 후보 대조용).
      if (code === 'P1') {
        await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: process.process_id, can_input_inspection: true } });
      }
      const worker = await prisma.worker.create({ data: {
        worker_no: `${PREFIX}-W-${code}`, worker_name: `OQC단말작업자${code}`,
        business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED',
      } });
      sessions.push({
        terminalId: terminal.terminal_id, workerNo: worker.worker_no, workerId: worker.worker_id, plantId: plant.plant_id,
        token: app.get(JwtService).sign({
          sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
          terminalCode: terminal.terminal_code, plantId: Number(plant.plant_id),
        }),
      });
    }
    [own, foreign] = sessions;

    const shipment = async (suffix: string, plantId: bigint | null) => (await prisma.shipment_request.create({ data: {
      shipment_request_no: `${PREFIX}-SR-${suffix}`, customer_id: customer, ship_to_partner_id: customer,
      requested_ship_date: new Date('2026-10-21'), status_code: 'REGISTERED', fulfillment_plant_id: plantId,
    } })).shipment_request_id;
    const ownSr = await shipment('OWN', own.plantId);
    const foreignSr = await shipment('FOREIGN', foreign.plantId);
    const noPlantSr = await shipment('NOPLANT', null);
    const lot = (await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT`, item_id: ids.item, lot_type_code: 'PRODUCT', plant_id: own.plantId,
      initial_qty: 10, uom_id: uom.uom_id, source_type_code: 'PRODUCTION_RESULT', source_id: 990001n, status_code: 'NORMAL',
    } })).lot_id;

    const oqc = async (suffix: string, targetId: bigint, extra: { lot_id?: bigint; status_code?: string } = {}) =>
      (await prisma.inspection_request.create({ data: {
        inspection_request_no: `${PREFIX}-IRQ-${suffix}`, inspection_type_code: 'OQC',
        target_type_code: 'SHIPMENT_REQUEST', target_id: targetId, item_id: ids.item, target_qty: 10, uom_id: uom.uom_id,
        status_code: extra.status_code ?? 'REQUESTED', requested_at: new Date('2026-10-20T01:00:00.000Z'),
        ...(extra.lot_id === undefined ? {} : { lot_id: extra.lot_id }),
      } })).inspection_request_id;
    ids.ownShipment = await oqc('OWN', ownSr);
    ids.ownShipmentRead = await oqc('OWN-READ', ownSr, { status_code: 'IN_PROGRESS' });
    ids.ownLot = await oqc('LOT', noPlantSr, { lot_id: lot });
    ids.foreignShipment = await oqc('FOREIGN', foreignSr);
    ids.noPlant = await oqc('NOPLANT', noPlantSr);
    ids.completed = await oqc('DONE', ownSr, { status_code: 'COMPLETED' });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({ where: { idempotency_key: { in: keys } } });
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    // ⛔ 단말 쓰기는 감사 행을 남기고 그 행이 단말을 FK 로 문다 — 단말보다 먼저 지운다.
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.inspection_result.deleteMany({ where: { inspection_request: { inspection_request_no: { startsWith: PREFIX } } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.shipment_request.deleteMany({ where: { shipment_request_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: ITEM_CODE } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
