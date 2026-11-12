/**
 * IQC 판정 — 합격판정개수 기준 자동 판정과 다르면 변경 사유가 필요하다 (e2e · omf-all-around#125 · 장부 P-70).
 *
 * 실제 API 로 잇는다 — 입하 LOT 받기·마감(피처 005)이 입하 LOT 단위 IQC 요청에 품목 전용 IQC 기준 버전을 붙이고, 판정(W-01-01)이
 * `:confirm` 또는 `POST …/inspection-results` statusCode=CONFIRMED(오프라인 큐)로 확정한다.
 * 기준: 불합격 > 합격판정개수 → 불합격 · 아니면 보류 > 0 → 보류 · 아니면 합격. 합격판정개수가 없으면 규칙이 없다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { InboundLotFixture, closeInboundLotFixture, issueAndReceive, terminalAuth } from './support/inbound-lot-fixture';

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
const TZ = 'Asia/Ho_Chi_Minh';
const WORKER_NO = `${PREFIX}-W1`;

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
  let supplierId: number;
  let fx: InboundLotFixture;
  const keys = new Set<string>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
    fx = {
      app, issuer: terminalAuth(await terminalToken('POP'), WORKER_NO), receiver: terminalAuth(await terminalToken('MOBILE'), WORKER_NO),
      businessDate: localDate(new Date(), TZ), keys,
    };
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
      // 합격 확정도 불합격 수량만큼의 불량 기록을 남긴다(omf-all-around#205).
      expect(await defectQtys(resultId)).toEqual([3]);
    });

    it('⛔ 불합격 3(≤5) + 합격 · 합계가 불합격 수량과 다르면 INVALID · LOT·결과 그대로', async () => {
      const { lotId, requestId } = await registerIqcLot(itemWithAn);
      const resultId = await draft(requestId, { acceptedQty: 97, rejectedQty: 3, defects: [] });

      const mismatched = await confirm(resultId, {
        overallJudgmentCode: 'ACCEPTED',
        defects: [{ defectCodeId, defectQty: 2, defectDescription: '찍힘' }],
      }).expect(400);
      expect(mismatched.body.errors[0]).toMatchObject({ field: 'defects', code: 'INVALID' });

      expect(await lotStatus(lotId)).toBe('INSPECTION_PENDING');
      expect(await resultStatus(resultId)).toBe('DRAFT');
      expect(await defectQtys(resultId)).toEqual([]);
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

  /**
   * 검사 필요 품목의 입하 LOT 하나(실제 API) — 발행 묶음(LOT 1개 · 100) → `:receive` → 입하 마감. 마감이 입하 LOT 단위 IQC 요청을
   * 세우고 품목 전용 IQC 기준 버전을 붙인다. 입하 LOT 에 LOT 이 하나라 요청 대상 = 그 LOT 이다.
   */
  async function registerIqcLot(itemId: number): Promise<{ lotId: number; requestId: number }> {
    const { lots, inboundLot } = await issueAndReceive(fx, { plantId, supplierId, itemId, lotQty: 100, lotCount: 1 });
    const closed = await closeInboundLotFixture(fx, inboundLot.inboundLotId);
    const iqc = await prisma.inspection_request.findFirstOrThrow({
      where: { inbound_lot_id: BigInt(inboundLot.inboundLotId), inspection_type_code: 'IQC' },
      select: { inspection_request_id: true, inspection_plan_version_id: true },
    });
    expect(Number(iqc.inspection_request_id)).toBe(closed.iqcRequestId);
    expect(iqc.inspection_plan_version_id).not.toBeNull();
    return { lotId: lots[0].lotId, requestId: Number(iqc.inspection_request_id) };
  }

  async function terminalToken(type: 'POP' | 'MOBILE'): Promise<string> {
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T-${type}`, plant_id: BigInt(plantId), terminal_type_code: type, status_code: 'RUNNING' },
    });
    return app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId,
    });
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

  /** 불합격 수량이 있으면 판정과 관계없이 확정에 불량 기록이 필요하다(omf-all-around#205) — 그 수량 한 줄. */
  function defectsFor(rejectedQty: number) {
    return rejectedQty > 0 ? { defects: [{ defectCodeId, defectQty: rejectedQty, defectDescription: '찍힘' }] } : {};
  }

  /** 불량 기록은 임시 저장에 함께 둔다 — `:confirm` 이 `defects` 를 생략하면 그 기록으로 확정한다. */
  async function draft(
    requestId: number,
    qty: { acceptedQty: number; rejectedQty: number; heldQty?: number } & Record<string, unknown>,
  ): Promise<number> {
    const { acceptedQty, rejectedQty, heldQty, ...extra } = qty;
    const response = await request(app.getHttpServer())
      .post('/api/quality/inspection-results')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...resultBody(requestId, { acceptedQty, rejectedQty, heldQty }), statusCode: 'DRAFT', ...defectsFor(rejectedQty), ...extra })
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
      .send({ ...resultBody(requestId, qty), statusCode: 'CONFIRMED', ...defectsFor(qty.rejectedQty), ...body });
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

  async function defectQtys(resultId: number): Promise<number[]> {
    const rows = await prisma.defect_record.findMany({
      where: { inspection_result_id: BigInt(resultId) }, select: { defect_qty: true },
    });
    return rows.map((row) => Number(row.defect_qty));
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
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'IQC판정사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PREFIX}-P`, plant_name: 'IQC판정공장', timezone_code: 'Asia/Ho_Chi_Minh' },
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
    supplierId = Number(supplier.partner_id);
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
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lotsOfPlant = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code IN ('${ITEM_AN}', '${ITEM_NO_AN}')`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const results = `SELECT inspection_result_id FROM quality.inspection_result WHERE inspection_request_id IN (${requests})`;
    // 입하 마감이 남기는 IQC 인계 알림.
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))`;
    const keyList = [...keys].map((k) => `'${k}'`).join(',');
    for (const sql of [
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.nonconformance_lot WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.defect_record WHERE defect_code_id IN (SELECT defect_code_id FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}')`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_result_lot WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_result WHERE inspection_result_id IN (${results})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lotsOfPlant})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lotsOfPlant})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
      `DELETE FROM quality.defect_code WHERE defect_code = '${DEFECT_CODE}'`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
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
