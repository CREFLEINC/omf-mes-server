/**
 * POP 자재 불량 등록(P-02-14 · omf-all-around#108 · 장부 P-52) — POP 단말(토큰 + `X-Worker-No`)이 쓰는 경로 (e2e).
 *
 * 원천 MATERIAL 로 투입 기록이 있는 자재 LOT 의 불량을 남기고(원천 문서 = 투입 기록), 같은 사번으로 그 LOT 을 보류한다.
 * 주체는 단말 작업자다. 화면 이동 후보는 검사 입력 공정(can_input_inspection) 단말에만 P-02-14 를 연다.
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

const PREFIX = 'MDPOP';
const ITEM_CODE = `${PREFIX}-ITEM`;
const DEFECT_CODE = `${PREFIX}-DEF`;
const DAY = '2026-10-16';

interface PopSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
  workerId: bigint;
  plantId: bigint;
}

describe('POP 자재 불량 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let own: PopSession;
  let foreign: PopSession;
  const keys: string[] = [];
  const ids = {
    uom: 0n, item: 0n, defectCode: 0n, process: 0n, workOrder: 0n,
    materialLot: 0n, foreignLot: 0n, consumption: 0n,
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

  it('⭐ POP 이 투입된 자재 LOT 의 불량을 남긴다 — W/O·투입 공정·원천 문서(투입 기록)를 서버가 채우고 주체는 단말 작업자다', async () => {
    const response = await asPop(request(app.getHttpServer())
      .post('/api/quality/defect-records')
      .set('Idempotency-Key', newKey())
      .send({
        sourceCode: 'MATERIAL', defectCodeId: Number(ids.defectCode), defectQty: 2, uomId: Number(ids.uom),
        detectedAt: `${DAY}T04:00:00.000Z`, lotId: Number(ids.materialLot), defectDescription: 'e2e 자재 긁힘',
      }), own).expect(201);

    const row = await prisma.defect_record.findUniqueOrThrow({ where: { defect_record_id: BigInt(response.body.defectRecordId) } });
    expect(row).toMatchObject({
      source_type_code: 'MATERIAL', lot_id: ids.materialLot, work_order_id: ids.workOrder,
      occurrence_process_id: ids.process, detection_process_id: ids.process,
      source_document_id: ids.consumption, worker_id: own.workerId, created_by: null,
    });
  });

  it('⭐ POP 이 같은 사번으로 그 LOT 을 보류한다 — 보류·상태 이력의 주체가 단말 작업자다', async () => {
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: ids.materialLot }, select: { version_no: true } });

    await asPop(request(app.getHttpServer())
      .post('/api/quality/lot-holds')
      .set('Idempotency-Key', newKey())
      .send({
        lots: [{ lotId: Number(ids.materialLot), versionNo: lot.version_no }],
        reasonCode: 'APPEARANCE_ABNORMAL', targetLotStatusCode: 'INSPECTION_PENDING',
        releaseCondition: '품질 판정 후 해제', remarks: 'e2e 자재 불량 보류',
      }), own).expect(201);

    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: ids.materialLot } })).status_code).toBe('INSPECTION_PENDING');
    const hold = await prisma.lot_hold.findFirstOrThrow({ where: { lot_id: ids.materialLot, reason_code: 'APPEARANCE_ABNORMAL' } });
    expect(hold).toMatchObject({ held_worker_id: own.workerId, held_by: null, released_at: null, release_condition: '품질 판정 후 해제' });
    const event = await prisma.lot_status_event.findFirstOrThrow({ where: { lot_id: ids.materialLot, new_status_code: 'INSPECTION_PENDING' } });
    expect(event).toMatchObject({ changed_worker_id: own.workerId, changed_by: null });
  });

  it('⛔ POP 은 남의 공장 LOT 에 불량·보류를 남기지 못하고, 자재 불량이 아닌 원천·서버가 채우는 칸도 못 보낸다 — 401', async () => {
    const defect = (lotId: bigint, sourceCode: string, extra: Record<string, unknown> = {}) => asPop(request(app.getHttpServer())
      .post('/api/quality/defect-records')
      .set('Idempotency-Key', newKey())
      .send({
        sourceCode, defectCodeId: Number(ids.defectCode), defectQty: 1, uomId: Number(ids.uom),
        detectedAt: `${DAY}T04:10:00.000Z`, lotId: Number(lotId), ...extra,
      }), own);

    await defect(ids.foreignLot, 'MATERIAL').expect(401);
    await defect(ids.materialLot, 'FIELD').expect(401);
    // #108 리뷰 m1 — W/O·공정은 서버가 투입 기록에서 채운다. 단말이 실어 보내면 받지 않는다.
    await defect(ids.materialLot, 'MATERIAL', { workOrderId: Number(ids.workOrder) }).expect(401);
    await defect(ids.materialLot, 'MATERIAL', { occurrenceProcessId: Number(ids.process) }).expect(401);
    await asPop(request(app.getHttpServer())
      .post('/api/quality/lot-holds')
      .set('Idempotency-Key', newKey())
      .send({ lots: [{ lotId: Number(ids.foreignLot), versionNo: 1 }], reasonCode: 'APPEARANCE_ABNORMAL', targetLotStatusCode: 'INSPECTION_PENDING', releaseCondition: '품질 판정 후 해제' }), own)
      .expect(401);
    expect(await prisma.lot_hold.count({ where: { lot_id: ids.foreignLot } })).toBe(0);
  });

  it('⭐ 화면 이동 후보 — 검사 입력 공정 단말에만 P-02-14(자재 불량)가 열린다', async () => {
    const screens = async (session: PopSession) => (await request(app.getHttpServer())
      .get(`/api/mdm/terminals/${String(session.terminalId)}/accessible-screens`)
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200)).body.screenCodes as string[];

    expect(await screens(own)).toContain('P-02-14');
    expect(await screens(foreign)).not.toContain('P-02-14');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function asPop(test: request.Test, session: PopSession): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  function newKey(): string {
    const value = randomUUID();
    keys.push(value);
    return value;
  }

  async function makeFixture(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '자재불량단말법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '자재불량단말사업부',
    } });
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({ data: {
      item_code: ITEM_CODE, item_name: '자재불량단말품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true,
    } });
    ids.item = item.item_id;
    ids.defectCode = (await prisma.defect_code.create({ data: { defect_code: DEFECT_CODE, defect_name: '자재불량단말불량' } })).defect_code_id;
    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '자재불량검사공정', process_type_code: 'INSPECTION' } });
    ids.process = process.process_id;

    const sessions: PopSession[] = [];
    for (const code of ['P1', 'P2']) {
      const plant = await prisma.plant.create({ data: {
        legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: `자재불량단말공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh',
      } });
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-POP-${code}`, plant_id: plant.plant_id, terminal_type_code: 'POP', status_code: 'RUNNING',
      } });
      // ⭐ 자기 공장 단말만 검사 입력 공정에 붙인다 — 남의 공장 단말은 매핑 0행이다(화면 후보 대조용).
      if (code === 'P1') {
        await prisma.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: process.process_id, can_input_inspection: true } });
      }
      const worker = await prisma.worker.create({ data: {
        worker_no: `${PREFIX}-W-${code}`, worker_name: `자재불량단말작업자${code}`,
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

    // 투입 기록이 있는 자재 LOT — 투입 공정은 비워 W/O 라우팅 공정으로 채워지게 한다.
    const line = await prisma.production_line.create({ data: { plant_id: own.plantId, line_code: `${PREFIX}-LINE`, line_name: '자재불량라인' } });
    const routing = await prisma.routing.create({ data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } });
    const operation = await prisma.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '자재불량작업',
    } });
    ids.workOrder = (await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO`, routing_operation_id: operation.routing_operation_id, item_id: item.item_id,
      order_qty: 10, uom_id: uom.uom_id, status_code: 'RELEASED', production_line_id: line.production_line_id,
    } })).work_order_id;
    const lot = (plantId: bigint, suffix: string) => prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${suffix}`, item_id: item.item_id, lot_type_code: 'MATERIAL', plant_id: plantId,
      initial_qty: 100, uom_id: uom.uom_id, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 990001n, status_code: 'NORMAL',
    } });
    ids.materialLot = (await lot(own.plantId, 'OWN')).lot_id;
    ids.foreignLot = (await lot(foreign.plantId, 'FOREIGN')).lot_id;
    ids.consumption = (await prisma.material_consumption.create({ data: {
      consumption_no: `${PREFIX}-MC`, work_order_id: ids.workOrder, item_id: item.item_id, lot_id: ids.materialLot,
      consumption_type_code: 'NORMAL', input_qty: 5, uom_id: uom.uom_id, occurred_at: new Date(`${DAY}T03:00:00.000Z`),
      worker_id: own.workerId, status_code: 'RECORDED', idempotency_key: `${PREFIX}-MC-KEY`,
    } })).material_consumption_id;

  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({ where: { idempotency_key: { in: keys } } });
    const terminalIds = (await prisma.terminal.findMany({ where: { terminal_code: { startsWith: PREFIX } }, select: { terminal_id: true } }))
      .map((row) => row.terminal_id);
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    // ⛔ 단말 쓰기는 감사 행을 남기고 그 행이 단말을 FK 로 문다 — 단말보다 먼저 지운다.
    await prisma.audit_event.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    for (const sql of [
      `DELETE FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}')`,
      `DELETE FROM production.material_consumption WHERE consumption_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.production_line WHERE line_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    await prisma.terminal_process.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.terminal.deleteMany({ where: { terminal_id: { in: terminalIds } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.defect_code.deleteMany({ where: { defect_code: DEFECT_CODE } });
    await prisma.item.deleteMany({ where: { item_code: ITEM_CODE } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});
