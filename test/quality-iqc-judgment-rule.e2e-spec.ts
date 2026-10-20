/**
 * IQC 판정 — 합격판정개수 기준 자동 판정과 다르면 변경 사유가 필요하다 (e2e · omf-all-around#125 · 장부 P-70).
 *
 * 실제 API 로 잇는다 — LOT 등록(P-01-01)이 품목 전용 IQC 기준 버전을 의뢰에 붙이고, 판정(W-01-01)이
 * `:confirm` 또는 `POST …/inspection-results` statusCode=CONFIRMED(오프라인 큐)로 확정한다.
 * 기준: 불합격 > 합격판정개수 → 불합격 · 아니면 보류 > 0 → 보류 · 아니면 합격. 합격판정개수가 없으면 규칙이 없다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-iqc-judgment';
const PASSWORD = 'IQC-판정-비밀번호';
const PREFIX = 'IQCJDG';
const ITEM_AN = 'IQCJDG-ITEM-AN';
const ITEM_NO_AN = 'IQCJDG-ITEM-NOAN';
const SUPPLIER_CODE = 'IQCJDG-SUP';
const DEFECT_CODE = 'IQCJDG-DEF';
const ROLE = 'E2E_IQC_JUDGMENT';
const PERMISSIONS = ['P-01-01', 'W-01-01'];
const DAY = '2026-10-20';
const REASON = '육안 재확인 — 경미한 외관 불량, 사용 가능';

const key = (): string => randomUUID();

describe('IQC 판정 변경 사유 (e2e · #125)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let plantId: number;
  let itemWithAn: number;
  let itemWithoutAn: number;
  let uomId: number;
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

  describe(':confirm', () => {
    it('⛔ 합격판정개수 5 · 불합격 10 + 합격 · 사유 없음 → 400 judgmentChangeReason REQUIRED · LOT 그대로', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10 });

      const response = await confirm(resultId, { overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(JSON.stringify(response.body)).toContain('judgmentChangeReason');
      expect(JSON.stringify(response.body)).toContain('합격판정개수(5)');
      expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
      expect(await resultStatus(resultId)).toBe('DRAFT');
    });

    it('⛔ 공백만인 사유는 없는 것이다 → 400', async () => {
      const { requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10 });

      await confirm(resultId, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: '   ' }).expect(400);
      // 계약 maxLength 500 — 계약 검증이 먼저 막는다.
      await confirm(resultId, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: '가'.repeat(501) }).expect(400);
    });

    it('⭐ 사유가 있으면 200 · 비고 맨 앞에 사유 · LOT 정상', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10 });

      const response = await confirm(resultId, {
        overallJudgmentCode: 'ACCEPTED',
        judgmentChangeReason: `  ${REASON} `,
        remarks: '검사 비고',
      }).expect(200);

      expect(response.body.remarks).toBe(`[판정 변경 사유] ${REASON}\n검사 비고`);
      expect(await storedRemarks(resultId)).toBe(`[판정 변경 사유] ${REASON}\n검사 비고`);
      expect(await lotStatus(lotId)).toBe('NORMAL');
    });

    it('⭐ 본문 비고가 없으면 저장된 비고를 사유 다음 줄에 둔다', async () => {
      const { requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10, remarks: '임시 저장 비고' });

      await confirm(resultId, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON }).expect(200);

      expect(await storedRemarks(resultId)).toBe(`[판정 변경 사유] ${REASON}\n임시 저장 비고`);
    });

    it('⭐ 불합격 3(≤5) + 합격 → 사유 없이 200 · 실린 사유는 버린다', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 97, rejectedQty: 3 });

      await confirm(resultId, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON }).expect(200);

      expect(await storedRemarks(resultId)).toBeNull();
      expect(await lotStatus(lotId)).toBe('NORMAL');
    });

    it('⭐ 불합격 10 + 불합격 + 불량 사유 → 200 · LOT 불량', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10 });

      await confirm(resultId, {
        overallJudgmentCode: 'REJECTED',
        defects: [{ defectCodeId, defectQty: 10, defectDescription: '찍힘' }],
      }).expect(200);

      expect(await lotStatus(lotId)).toBe('DEFECTIVE');
      expect(await storedRemarks(resultId)).toBeNull();
    });

    it('⛔ 보류 2 · 불합격 3(≤5) + 합격 · 사유 없음 → 400 (자동 판정 보류)', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 95, rejectedQty: 3, heldQty: 2 });

      const response = await confirm(resultId, { overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(JSON.stringify(response.body)).toContain('judgmentChangeReason');
      expect(JSON.stringify(response.body)).toContain('보류');
      expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
    });

    it('⭐ 합격판정개수가 없는 기준이면 규칙이 없다 — 불합격 10 + 합격 → 200(종전 그대로)', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithoutAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10 });

      await confirm(resultId, { overallJudgmentCode: 'ACCEPTED' }).expect(200);

      expect(await storedRemarks(resultId)).toBeNull();
      expect(await lotStatus(lotId)).toBe('NORMAL');
    });
  });

  describe('POST statusCode=CONFIRMED (오프라인 큐)', () => {
    it('⛔ 합격판정개수 5 · 불합격 10 + 합격 · 사유 없음 → 400 · 결과가 안 생긴다', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);

      const response = await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(JSON.stringify(response.body)).toContain('judgmentChangeReason');
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(0);
      expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
    });

    it('⭐ 사유가 있으면 201 · 비고 맨 앞에 사유 · LOT 정상', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);

      const response = await postConfirmed(
        requestId,
        { acceptedQty: 90, rejectedQty: 10 },
        { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON, remarks: '현장 비고' },
      ).expect(201);

      expect(response.body.remarks).toBe(`[판정 변경 사유] ${REASON}\n현장 비고`);
      expect(await lotStatus(lotId)).toBe('NORMAL');
    });

    it('⭐ 불합격 3 + 합격 → 사유 없이 201', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);

      await postConfirmed(requestId, { acceptedQty: 97, rejectedQty: 3 }, { overallJudgmentCode: 'ACCEPTED' }).expect(201);

      expect(await lotStatus(lotId)).toBe('NORMAL');
    });

    it('⛔ 보류 2 + 합격 · 사유 없음 → 400', async () => {
      const { requestId } = await registerIqcLot(itemWithAn);

      await postConfirmed(requestId, { acceptedQty: 98, rejectedQty: 0, heldQty: 2 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);
    });

    it('⭐ 합격판정개수가 없으면 불합격 10 + 합격 → 201(종전 그대로)', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithoutAn);

      await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED' }).expect(201);

      expect(await lotStatus(lotId)).toBe('NORMAL');
    });

    it('⭐ 작성중(DRAFT) 저장은 보지 않는다 — 사유를 실어도 버린다', async () => {
      const { requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 90, rejectedQty: 10, overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON });

      expect(await storedRemarks(resultId)).toBeNull();
    });
  });

  /** IQC 대상 입하 라인 + LOT 등록(실제 API) — 품목 전용 IQC 기준 버전이 의뢰에 붙는다. */
  async function registerIqcLot(itemId: number): Promise<{ lotId: number; requestId: number }> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: 100,
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
        initialQty: 100,
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
      select: { inspection_request_id: true, inspection_plan_version_id: true },
    });
    expect(iqc.inspection_plan_version_id).not.toBeNull();
    return { lotId, requestId: Number(iqc.inspection_request_id) };
  }

  function resultBody(requestId: number, qty: { acceptedQty: number; rejectedQty: number; heldQty?: number }) {
    const heldQty = qty.heldQty ?? 0;
    return {
      inspectionRequestId: requestId,
      inspectedQty: qty.acceptedQty + qty.rejectedQty + heldQty,
      acceptedQty: qty.acceptedQty,
      rejectedQty: qty.rejectedQty,
      heldQty,
      uomId,
      inspectedAt: `${DAY}T03:00:00.000Z`,
    };
  }

  async function draft(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; heldQty?: number } & Record<string, unknown>,
  ): Promise<number> {
    const { acceptedQty, rejectedQty, heldQty, ...extra } = qty;
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...resultBody(requestId, { acceptedQty, rejectedQty, heldQty }), statusCode: 'DRAFT', ...extra })
      .expect(201);
    return response.body.inspectionResultId as number;
  }

  function postConfirmed(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; heldQty?: number },
    body: Record<string, unknown>,
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...resultBody(requestId, qty), statusCode: 'CONFIRMED', ...body });
  }

  function confirm(resultId: number, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send(body);
  }

  async function lotStatus(lotId: number): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId) }, select: { status_code: true } })).status_code;
  }

  async function resultStatus(resultId: number): Promise<string> {
    return (await prisma.inspection_result.findUniqueOrThrow({
      where: { inspection_result_id: BigInt(resultId) }, select: { status_code: true },
    })).status_code;
  }

  async function storedRemarks(resultId: number): Promise<string | null> {
    return (await prisma.inspection_result.findUniqueOrThrow({
      where: { inspection_result_id: BigInt(resultId) }, select: { remarks: true },
    })).remarks;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'IQC판정법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'IQC판정사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'IQC판정공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const itemOf = (code: string) =>
      prisma.item.create({
        data: { item_code: code, item_name: code, item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true, inspection_required: true },
      });
    const withAn = await itemOf(ITEM_AN);
    const withoutAn = await itemOf(ITEM_NO_AN);
    itemWithAn = Number(withAn.item_id);
    itemWithoutAn = Number(withoutAn.item_id);
    // 품목 전용 IQC 기준 — 확정 버전 1건씩. 하나는 합격판정개수 5, 하나는 비움.
    const planOf = async (itemId: bigint, suffix: string, acceptanceNumber: number | null) => {
      const plan = await prisma.inspection_plan.create({
        data: { inspection_plan_code: `${PREFIX}-PLAN-${suffix}`, inspection_plan_name: `IQC판정기준${suffix}`, item_id: itemId, inspection_type_code: 'IQC' },
      });
      await prisma.inspection_plan_version.create({
        data: {
          inspection_plan_id: plan.inspection_plan_id,
          plan_version: 1,
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          sampling_method_code: 'SAMPLE_BY_LOT',
          inspection_frequency_code: 'EVERY_LOT',
          status_code: 'CONFIRMED',
          acceptance_number: acceptanceNumber,
        },
      });
    };
    await planOf(withAn.item_id, 'AN', 5);
    await planOf(withoutAn.item_id, 'NOAN', null);
    const supplier = await prisma.partner.create({ data: { partner_code: SUPPLIER_CODE, partner_name: 'IQC판정공급사' } });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: supplier.partner_id, plant_id: plant.plant_id,
        receipt_datetime: new Date(`${DAY}T02:00:00.000Z`), status_code: 'REGISTERED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
    const code = await prisma.defect_code.create({ data: { defect_code: DEFECT_CODE, defect_name: 'IQC판정불량' } });
    defectCodeId = Number(code.defect_code_id);
    await prisma.process.upsert({
      where: { process_code: 'IQC' },
      update: {},
      create: { process_code: 'IQC', process_name: '수입검사', process_type_code: 'INSPECTION' },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: 'IQC판정', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'IQC판정용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const unit = await prisma.business_unit.findFirstOrThrow({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: 'IQC판정검사자', business_unit_id: unit.business_unit_id,
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

  /** 이 스위트가 만든 행만 지운다 — 원장(TRUNCATE)은 건드리지 않는다(입고를 하지 않는다). */
  async function cleanup(): Promise<void> {
    const lotsOfPlant = `SELECT lot_id FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code IN ('${ITEM_AN}', '${ITEM_NO_AN}')`;
    for (const sql of [
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}')`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (SELECT inspection_request_id FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant}))`,
      `DELETE FROM quality.inspection_request WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lotsOfPlant})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code = '${SUPPLIER_CODE}'`,
      `DELETE FROM mdm.item WHERE item_code IN ('${ITEM_AN}', '${ITEM_NO_AN}')`,
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
