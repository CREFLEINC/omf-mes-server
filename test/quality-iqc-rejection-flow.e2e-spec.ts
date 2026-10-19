/**
 * IQC 불합격 → 처분(재작업) → 재검사 → 입고 (e2e · omf-all-around#106).
 *
 * 실제 API 로 잇는다 — LOT 등록(P-01-01) · 판정(W-01-01) · 처분(W-03-10) · 입고(W-01-10).
 *
 * 걸리는 규칙: #100(합격 전 입고 차단 · 불합격은 불량창고로만) · #106(불합격 사유 필수 · 부적합 자동 등록 P-41 ·
 * 재작업이 의뢰를 다시 연다 P-43 · 처분 전 재검사 차단).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-iqc-flow';
const PASSWORD = 'IQC-흐름-비밀번호';
const PREFIX = 'IQCFLOW';
const ITEM_CODE = 'IQCFLOW-ITEM';
const SUPPLIER_CODE = 'IQCFLOW-SUP';
const DEFECT_CODE = 'IQCFLOW-DEF';
const ROLE = 'E2E_IQC_FLOW';
const PERMISSIONS = ['P-01-01', 'W-01-01', 'W-03-10', 'W-01-10'];
const DAY = '2026-10-16';

const key = (): string => randomUUID();

describe('IQC 불합격 → 처분 → 입고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let plantId: number;
  let itemId: number;
  let uomId: number;
  let warehouseId: number;
  let locationId: number;
  let defectWarehouseId: number;
  let defectLocationId: number;
  let defectCodeId: number;
  let inboundReceiptId: bigint;
  let lineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 합격 전에는 입고되지 않는다(#100) — 불합격은 사유가 있어야 확정되고(#106) 부적합이 선다(P-41)', async () => {
    const { lotId, lineId, requestId } = await registerIqcLot(10);
    await receive(lotId, lineId, 10).expect(400);

    const resultId = await draft(requestId, { acceptedQty: 0, rejectedQty: 10 });
    await confirm(resultId, 'REJECTED').expect(400);
    await recordReason(resultId);
    await confirm(resultId, 'REJECTED').expect(200);

    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
    const nc = await openNonconformance(lotId);
    expect(nc).toMatchObject({ status_code: 'PENDING_DECISION', inspection_result_id: BigInt(resultId) });
    await receive(lotId, lineId, 10).expect(400);
  });

  it('⭐ 불합격 LOT 은 불량창고로만 입고된다(#100 · P-45) — 일반 창고는 계속 거부', async () => {
    const { lotId, lineId } = await rejectedLot(10);

    const rejected = await receive(lotId, lineId, 10).expect(400);
    expect(JSON.stringify(rejected.body)).toContain('불량창고로만');
    await receive(lotId, lineId, 10, { warehouseId: defectWarehouseId, locationId: defectLocationId }).expect(201);
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
  });

  it('⭐ 재작업 → 검사 대기(보류 유지) → 재검 회차 합격 → 보류 해제 → 입고', async () => {
    const { lotId, lineId, requestId, resultId } = await rejectedLot(10);
    const nc = await openNonconformance(lotId);

    expect(await requestStatus(requestId)).toBe('COMPLETED');
    await decide(nc.nonconformance_id, { dispositionTypeCode: 'REWORK', decisionQty: 10 }).expect(201);
    expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
    expect(await openInspectionHolds(lotId)).toBe(1);
    await receive(lotId, lineId, 10).expect(400);
    // 재작업이 IQC 의뢰를 다시 연다 — 판정 화면 대기 큐에 다시 떠야 재검사를 시작한다(장부 P-43 · 3단계 검증).
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    expect(await pendingQueueIds()).toContain(requestId);

    const second = await draft(requestId, { acceptedQty: 10, rejectedQty: 0, previousResultId: resultId });
    expect(await requestStatus(requestId)).toBe('IN_PROGRESS');
    await confirm(second, 'ACCEPTED').expect(200);
    expect(await requestStatus(requestId)).toBe('COMPLETED');

    expect(await lotStatus(lotId)).toBe('NORMAL');
    expect(await openInspectionHolds(lotId)).toBe(0);
    await receive(lotId, lineId, 10).expect(201);
  });

  /* #106 · 3단계 검증 — 처분(재작업) 없이 불합격 LOT 을 재검사하지 못한다. 작성중·확정 어느 쪽으로도 회차가 생기지 않는다. */
  it('⛔ 처분 전 불합격 LOT 에는 재검사 회차를 만들 수 없다 — LOT 은 불량 그대로, 의뢰도 완료 그대로', async () => {
    const { lotId, requestId, resultId } = await rejectedLot(10);
    const reinspect = (statusCode: 'DRAFT' | 'CONFIRMED') =>
      request(app.getHttpServer())
        .post('/api/quality/inspection-results')
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send({
          inspectionRequestId: requestId, inspectedQty: 10, acceptedQty: 10, rejectedQty: 0, heldQty: 0,
          uomId, inspectedAt: `${DAY}T04:00:00.000Z`, statusCode, previousResultId: resultId,
          ...(statusCode === 'CONFIRMED' ? { overallJudgmentCode: 'ACCEPTED' } : {}),
        });

    const drafted = await reinspect('DRAFT').expect(400);
    expect(JSON.stringify(drafted.body)).toContain('처분 판정(재작업) 뒤에');
    await reinspect('CONFIRMED').expect(400);

    expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(1);
    expect(await requestStatus(requestId)).toBe('COMPLETED');
    expect(await lotStatus(lotId)).toBe('DEFECTIVE');
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function rejectedLot(qty: number) {
    const lot = await registerIqcLot(qty);
    const resultId = await draft(lot.requestId, { acceptedQty: 0, rejectedQty: qty });
    await recordReason(resultId);
    await confirm(resultId, 'REJECTED').expect(200);
    return { ...lot, resultId };
  }

  /** IQC 대상 입하 라인 + LOT 등록(실제 API) — 검사기준이 없어도 기준 빈 의뢰가 선다(#101). */
  async function registerIqcLot(qty: number): Promise<{ lotId: number; lineId: number; requestId: number }> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: qty,
        uom_id: BigInt(uomId),
        supplier_lot_label_attached: false,
        inspection_required: true,
        status_code: 'REGISTERED',
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        itemId,
        lotTypeCode: 'MATERIAL',
        plantId,
        initialQty: qty,
        uomId,
        sourceTypeCode: 'INBOUND_RECEIPT_LINE',
        sourceId: Number(line.inbound_receipt_line_id),
        numberSourceCode: 'MES',
        businessDate: DAY,
        occurredAt: `${DAY}T02:00:00.000Z`,
      })
      .expect(201);
    const lotId = created.body.lot.lotId as number;
    const iqc = await prisma.inspection_request.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), inspection_type_code: 'IQC' },
      select: { inspection_request_id: true },
    });
    return { lotId, lineId: Number(line.inbound_receipt_line_id), requestId: Number(iqc.inspection_request_id) };
  }

  async function draft(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; previousResultId?: number },
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        inspectionRequestId: requestId,
        inspectedQty: qty.acceptedQty + qty.rejectedQty,
        acceptedQty: qty.acceptedQty,
        rejectedQty: qty.rejectedQty,
        heldQty: 0,
        uomId,
        inspectedAt: `${DAY}T03:00:00.000Z`,
        statusCode: 'DRAFT',
        ...(qty.previousResultId === undefined ? {} : { previousResultId: qty.previousResultId }),
      })
      .expect(201);
    return response.body.inspectionResultId as number;
  }

  function confirm(resultId: number, judgment: string): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ overallJudgmentCode: judgment });
  }

  async function recordReason(resultId: number): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/quality/defect-records')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        sourceCode: 'IQC',
        defectCodeId,
        defectQty: 1,
        uomId,
        detectedAt: `${DAY}T03:10:00.000Z`,
        inspectionResultId: resultId,
        defectDescription: '외관 긁힘',
      })
      .expect(201);
  }

  function decide(nonconformanceId: bigint, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/nonconformances/${String(nonconformanceId)}/disposition-decisions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ uomId, reason: 'e2e 처분', ...body });
  }

  function receive(
    lotId: number,
    lineId: number,
    qty: number,
    to: { warehouseId: number; locationId: number } = { warehouseId, locationId },
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId: to.warehouseId,
        receiptDatetime: `${DAY}T05:00:00.000Z`,
        businessDate: DAY,
        lines: [
          {
            inboundReceiptLineId: lineId,
            itemId,
            lotId,
            receiptQty: qty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: to.locationId,
          },
        ],
      });
  }

  async function requestStatus(requestId: number): Promise<string> {
    return (await prisma.inspection_request.findUniqueOrThrow({
      where: { inspection_request_id: BigInt(requestId) }, select: { status_code: true },
    })).status_code;
  }

  /** IQC 판정 화면 대기 큐(W-01-01 — `pendingOnly` 고정)에 선 의뢰들. */
  async function pendingQueueIds(): Promise<number[]> {
    const response = await request(app.getHttpServer())
      .get('/api/quality/inspection-requests')
      .query({ inspectionTypeCode: 'IQC', pendingOnly: 'true', page: 1, size: 100 })
      .set('Cookie', cookie)
      .expect(200);
    return (response.body.items as { inspectionRequestId: number }[]).map((row) => row.inspectionRequestId);
  }

  async function lotStatus(lotId: number): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { status_code: true } })).status_code;
  }

  async function openInspectionHolds(lotId: number): Promise<number> {
    return prisma.lot_hold.count({
      where: { lot_id: BigInt(lotId), reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null },
    });
  }

  async function openNonconformance(lotId: number) {
    const row = await prisma.nonconformance_lot.findFirstOrThrow({
      where: { lot_id: BigInt(lotId), nonconformance: { closed_at: null } },
      select: { nonconformance: { select: { nonconformance_id: true, status_code: true, inspection_result_id: true, version_no: true } } },
    });
    return row.nonconformance;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'IQC흐름법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'IQC흐름사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'IQC흐름공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: { item_code: ITEM_CODE, item_name: 'IQC흐름품목', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true, inspection_required: true },
    });
    itemId = Number(item.item_id);
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`,
        warehouse_name: 'IQC흐름창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const location = await prisma.location.create({
      data: { warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: 'IQC흐름위치', location_type_code: 'BIN' },
    });
    locationId = Number(location.location_id);
    const defectWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-NG`,
        warehouse_name: 'IQC흐름불량창고', warehouse_type_code: 'RAW', management_level_code: 'LOCATION', is_defect: true,
      },
    });
    defectWarehouseId = Number(defectWarehouse.warehouse_id);
    const defectLocation = await prisma.location.create({
      data: { warehouse_id: defectWarehouse.warehouse_id, location_code: `${PREFIX}-NGLOC`, location_name: 'IQC흐름불량위치', location_type_code: 'BIN' },
    });
    defectLocationId = Number(defectLocation.location_id);
    const supplier = await prisma.partner.create({ data: { partner_code: SUPPLIER_CODE, partner_name: 'IQC흐름공급사' } });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: supplier.partner_id, plant_id: plant.plant_id,
        receipt_datetime: new Date(`${DAY}T02:00:00.000Z`), status_code: 'REGISTERED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
    const code = await prisma.defect_code.create({ data: { defect_code: DEFECT_CODE, defect_name: 'IQC흐름불량' } });
    defectCodeId = Number(code.defect_code_id);
    // 수입검사 공정은 시드가 세운다(`seedSystemProcesses`) — 없으면 불량 기록이 400 이다.
    await prisma.process.upsert({
      where: { process_code: 'IQC' },
      update: {},
      create: { process_code: 'IQC', process_name: '수입검사', process_type_code: 'INSPECTION' },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: 'IQC흐름', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'IQC흐름용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    // #104 — 관리웹 판정의 검사자는 계정에 연결된 작업자다.
    const unit = await prisma.business_unit.findFirstOrThrow({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: 'IQC흐름검사자', business_unit_id: unit.business_unit_id,
        plant_id: BigInt(plantId), app_user_id: user.app_user_id, status_code: 'EMPLOYED',
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    const lotsOfPlant = `SELECT lot_id FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    for (const sql of [
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant}))`,
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`,
      `DELETE FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}')`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (SELECT inspection_request_id FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant}))`,
      `DELETE FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${lotsOfPlant}) OR target_lot_id IN (${lotsOfPlant})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code = '${SUPPLIER_CODE}'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
