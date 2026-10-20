/**
 * OQC 판정 — 합격판정개수 기준 자동 판정과 다르면 변경 사유가 필요하다 (e2e · omf-all-around#126 · 장부 P-70).
 *
 * 실제 API 로 잇는다 — 출하요청 편성(W-04-01)이 검사 필수 라인의 품목별 OQC 의뢰를 세우고, 판정(W-04-03)이
 * `POST …/inspection-results` statusCode=CONFIRMED 로 확정한다. 출하 관문은 출하요청
 * 상세(W-04-04)의 `shippingInspectionStatusCode` 로 본다 — 관문은 판정 코드만 보므로 규칙이 확정 시점에서 막는다.
 * 기준: 불합격 > 합격판정개수 → 불합격 · 아니면 보류 > 0 → 보류 · 아니면 합격. 합격판정개수가 없으면 규칙이 없다(IQC #125 와 같다).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-oqc-judgment';
const PASSWORD = 'OQC-판정-비밀번호';
const PREFIX = 'OQCJDG';
const ITEM_AN = 'OQCJDG-ITEM-AN';
const ITEM_NO_AN = 'OQCJDG-ITEM-NOAN';
const ROLE = 'E2E_OQC_JUDGMENT';
const PERMISSIONS = ['W-04-01', 'W-04-03', 'W-04-04'];
const DAY = '2026-10-20';
const REASON = '고객 승인 — 경미한 외관 차이, 출하 허용';

const key = (): string => randomUUID();

describe('OQC 판정 변경 사유 (e2e · #126)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let itemWithAn: number;
  let itemWithoutAn: number;
  let uomId: number;
  let customerId: number;

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

  /*
   * ⚠ OQC 확정은 `POST …/inspection-results` statusCode=CONFIRMED 하나로 한다 — 관리웹 W-04-03 · POP P-04-06 둘 다 이 경로다
   *   (`:confirm` 은 W-01-01 권한 · 관리웹 OQC 에는 작성중·잠금 갈래가 없다). 규칙 함수는 두 경로가 같다(단위 테스트).
   */
  describe('POST statusCode=CONFIRMED (W-04-03 · P-04-06 확정 경로)', () => {
    it('⛔ 합격판정개수 5 · 불합격 10 + 합격 · 사유 없음 → 400 judgmentChangeReason REQUIRED · 결과 없음 · 출하 관문 대기', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithAn);

      const response = await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(JSON.stringify(response.body)).toContain('judgmentChangeReason');
      expect(JSON.stringify(response.body)).toContain('합격판정개수(5)');
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(0);
      expect(await gate(shipmentRequestId)).toBe('PENDING');
    });

    it('⛔ 공백만인 사유는 없는 것이다 · 501자는 계약이 막는다 → 400', async () => {
      const { requestId } = await newOqcRequest(itemWithAn);

      await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: '   ' }).expect(400);
      await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: '가'.repeat(501) }).expect(400);
    });

    it('⭐ 사유가 있으면 201 · 비고 맨 앞에 사유 · 출하 관문 통과(판정 코드 그대로)', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithAn);

      const response = await postConfirmed(
        requestId,
        { acceptedQty: 90, rejectedQty: 10 },
        { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: `  ${REASON} `, remarks: '출하 검사 비고' },
      ).expect(201);

      expect(response.body.remarks).toBe(`[판정 변경 사유] ${REASON}\n출하 검사 비고`);
      expect(await gate(shipmentRequestId)).toBe('PASSED');
    });

    it('⭐ 불합격 10 + 불합격 → 201 · 출하 관문 불합격', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithAn);

      const response = await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'REJECTED' }).expect(201);

      expect(response.body.remarks ?? null).toBeNull();
      expect(await gate(shipmentRequestId)).toBe('REJECTED');
    });

    it('⭐ 불합격 3(≤5) + 합격 → 사유 없이 201 · 실린 사유는 버린다 · 관문 통과', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithAn);

      const response = await postConfirmed(
        requestId,
        { acceptedQty: 97, rejectedQty: 3 },
        { overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON },
      ).expect(201);

      expect(response.body.remarks ?? null).toBeNull();
      expect(await gate(shipmentRequestId)).toBe('PASSED');
    });

    it('⛔ 보류 2 · 불합격 0 + 합격 · 사유 없음 → 400 (자동 판정 보류) · 보류로 고르면 201 · 관문 보류', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithAn);

      const response = await postConfirmed(requestId, { acceptedQty: 98, rejectedQty: 0, heldQty: 2 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);
      expect(JSON.stringify(response.body)).toContain('보류');

      await postConfirmed(requestId, { acceptedQty: 98, rejectedQty: 0, heldQty: 2 }, { overallJudgmentCode: 'HELD' }).expect(201);
      expect(await gate(shipmentRequestId)).toBe('HELD');
    });

    it('⭐ 합격판정개수가 없는 기준이면 규칙이 없다 — 불합격 10 + 합격 → 201(종전 그대로) · 관문 통과', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithoutAn);

      const response = await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED' }).expect(201);

      expect(response.body.remarks ?? null).toBeNull();
      expect(await gate(shipmentRequestId)).toBe('PASSED');
    });

    it('⭐ 작성중(DRAFT) 저장은 보지 않는다 — 사유를 실어도 버린다', async () => {
      const { requestId } = await newOqcRequest(itemWithAn);

      const response = await request(app.getHttpServer())
        .post('/api/quality/inspection-results')
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send({ ...resultBody(requestId, { acceptedQty: 90, rejectedQty: 10 }), statusCode: 'DRAFT', overallJudgmentCode: 'ACCEPTED', judgmentChangeReason: REASON })
        .expect(201);

      expect(response.body.remarks ?? null).toBeNull();
    });
  });

  /** 출하요청 편성(실제 API) — 검사 필수 라인 하나라 그 품목의 OQC 의뢰 하나가 선다(헤더 대상 · LOT 없음). */
  async function newOqcRequest(itemId: number): Promise<{ shipmentRequestId: number; requestId: number }> {
    const created = await request(app.getHttpServer())
      .post('/api/logistics/shipment-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        customerId,
        shipToPartnerId: customerId,
        requestedShipDate: DAY,
        lines: [{ itemId, requestedQty: 100, allocatedQty: 100, uomId, shippingInspectionRequired: true }],
      })
      .expect(201);
    const shipmentRequestId = created.body.shipmentRequestId as number;
    const oqc = await prisma.inspection_request.findFirstOrThrow({
      where: { inspection_type_code: 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: BigInt(shipmentRequestId) },
      select: { inspection_request_id: true, inspection_plan_version_id: true },
    });
    expect(oqc.inspection_plan_version_id).not.toBeNull();
    return { shipmentRequestId, requestId: Number(oqc.inspection_request_id) };
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


  /** 출하 관문 — 출하요청 상세의 검사 상태(PENDING · PASSED · REJECTED · HELD). */
  async function gate(shipmentRequestId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/shipment-requests/${shipmentRequestId}`)
      .set('Cookie', cookie)
      .expect(200);
    return (response.body.shipmentRequest ?? response.body).shippingInspectionStatusCode as string;
  }



  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'OQC판정법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'OQC판정사업부' },
    });
    await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'OQC판정공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
    uomId = Number(uom.uom_id);
    const itemOf = (code: string) =>
      prisma.item.create({ data: { item_code: code, item_name: code, item_type_code: 'FINISHED', base_uom_id: uom.uom_id } });
    const withAn = await itemOf(ITEM_AN);
    const withoutAn = await itemOf(ITEM_NO_AN);
    itemWithAn = Number(withAn.item_id);
    itemWithoutAn = Number(withoutAn.item_id);
    // 품목 전용 OQC 기준 — 확정 버전 1건씩. 하나는 합격판정개수 5, 하나는 비움.
    const planOf = async (itemId: bigint, suffix: string, acceptanceNumber: number | null) => {
      const plan = await prisma.inspection_plan.create({
        data: { inspection_plan_code: `${PREFIX}-PLAN-${suffix}`, inspection_plan_name: `OQC판정기준${suffix}`, item_id: itemId, inspection_type_code: 'OQC' },
      });
      await prisma.inspection_plan_version.create({
        data: {
          inspection_plan_id: plan.inspection_plan_id,
          plan_version: 1,
          effective_from: new Date('2020-01-01T00:00:00.000Z'),
          sampling_method_code: 'SAMPLE_BY_LOT',
          inspection_frequency_code: 'PRODUCTION_LOT',
          status_code: 'CONFIRMED',
          acceptance_number: acceptanceNumber,
        },
      });
    };
    await planOf(withAn.item_id, 'AN', 5);
    await planOf(withoutAn.item_id, 'NOAN', null);
    const customer = await prisma.partner.create({ data: { partner_code: `${PREFIX}-C1`, partner_name: 'OQC판정고객' } });
    customerId = Number(customer.partner_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: 'OQC판정', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'OQC판정용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const unit = await prisma.business_unit.findFirstOrThrow({ where: { business_unit_code: `${PREFIX}-BU` } });
    const plant = await prisma.plant.findFirstOrThrow({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`, worker_name: 'OQC판정검사자', business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id, app_user_id: user.app_user_id, status_code: 'EMPLOYED',
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

  /** 이 스위트가 만든 행만 지운다. */
  async function cleanup(): Promise<void> {
    const items = `SELECT item_id FROM mdm.item WHERE item_code IN ('${ITEM_AN}', '${ITEM_NO_AN}')`;
    const requests = `SELECT shipment_request_id FROM logistics.shipment_request WHERE customer_id IN (SELECT partner_id FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%')`;
    const oqc = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    for (const sql of [
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (${items}))`,
      `DELETE FROM quality.nonconformance WHERE item_id IN (${items})`,
      `DELETE FROM quality.inspection_result WHERE inspection_request_id IN (${oqc})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%')`,
      `DELETE FROM quality.inspection_plan WHERE inspection_plan_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
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
