/**
 * OQC 판정 — 합격판정개수 기준 자동 판정과 다르면 변경 사유가 필요하다 (e2e · omf-all-around#126 · 장부 P-70).
 *
 * 실제 API 로 잇는다 — 출하요청 편성(W-04-01)이 검사 필수 라인의 품목별 OQC 의뢰를 세우고, 판정(W-04-03)이
 * `POST …/inspection-results` statusCode=CONFIRMED 로 확정한다. 출하 관문은 출하요청
 * 상세(W-04-04)의 `shippingInspectionStatusCode` 로 본다 — 관문은 판정 코드만 보므로 규칙이 확정 시점에서 막는다.
 * 기준: 불합격 > 합격판정개수 → 불합격 · 아니면 보류 > 0 → 보류 · 아니면 합격. 합격판정개수가 없으면 규칙이 없다(IQC #125 와 같다).
 *
 * #119(장부 P-83) — OQC 확정은 검사 대상 라인의 피킹이 끝나야 하고(D6-b), 집은 LOT 에 판정을 남긴다(합격 C4 · 불합격 C6).
 * 피킹은 이 스위트의 관심 밖이라 예약 행을 직접 심는다(`pick`). 생략 경로(요청 → 결재 → 실행)도 여기서 잇는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { seedRoute } from './approval-request.fixture';

const LOGIN_ID = 'e2e-oqc-judgment';
const PASSWORD = 'OQC-판정-비밀번호';
const PREFIX = 'OQCJDG';
const ITEM_AN = 'OQCJDG-ITEM-AN';
const ITEM_NO_AN = 'OQCJDG-ITEM-NOAN';
const ROLE = 'E2E_OQC_JUDGMENT';
const PERMISSIONS = ['W-04-01', 'W-04-03', 'W-04-04', 'W-03-09'];
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
  let plantId: bigint;
  let warehouseId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
    // 개발 DB 의 결재선은 0행이다 — 안 심으면 생략 상신이 400 `ROUTE_NOT_FOUND` 다. 결재자는 이 스위트의 계정이다.
    await seedRoute(prisma, 'OQC_SKIP', [userId]);
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

  describe('#119 — 피킹 전제와 피킹 LOT 이력(D6)', () => {
    it('⛔ 검사 대상 라인의 피킹이 덜 끝났으면 확정이 400 · 결과 없음', async () => {
      const { requestId } = await newOqcRequest(itemWithoutAn, { picked: false });

      const response = await postConfirmed(requestId, { acceptedQty: 100, rejectedQty: 0 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);

      expect(JSON.stringify(response.body)).toContain('피킹을 마친 뒤 판정하세요');
      expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(0);
    });

    it('⭐ 합격 확정은 집은 LOT 에 C4(정상 → 정상) 이력을 남긴다', async () => {
      const { requestId, lotId } = await newOqcRequest(itemWithoutAn);

      await postConfirmed(requestId, { acceptedQty: 100, rejectedQty: 0 }, { overallJudgmentCode: 'ACCEPTED' }).expect(201);

      expect(await lotOf(lotId)).toBe('NORMAL');
      expect(await transitionsOf(lotId)).toEqual(['C4']);
    });

    it('⭐ 불합격 확정은 집은 LOT 을 불량(C6)으로 옮긴다', async () => {
      const { requestId, lotId } = await newOqcRequest(itemWithoutAn);

      await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'REJECTED' }).expect(201);

      expect(await lotOf(lotId)).toBe('DEFECTIVE');
      expect(await transitionsOf(lotId)).toEqual(['C6']);
    });

    it('보류 확정은 LOT 을 옮기지 않는다', async () => {
      const { requestId, lotId } = await newOqcRequest(itemWithoutAn);

      await postConfirmed(requestId, { acceptedQty: 98, rejectedQty: 0, heldQty: 2 }, { overallJudgmentCode: 'HELD' }).expect(201);

      expect(await lotOf(lotId)).toBe('NORMAL');
      expect(await transitionsOf(lotId)).toEqual([]);
    });
  });

  describe('#119 — OQC 생략(요청 → 결재 → 실행 · 장부 P-83)', () => {
    it('⭐ 승인 뒤 실행하면 의뢰가 SKIPPED · 출하 관문 통과 · 집은 LOT 에 C27', async () => {
      const { shipmentRequestId, requestId, lotId } = await newOqcRequest(itemWithoutAn);

      const requested = await skipRequest(shipmentRequestId).expect(202);
      const approvalRequestId = requested.body.approvalRequestId as number;
      // 승인 전 실행은 막힌다 — 승인은 잠금만 푼다(J-8).
      expect(JSON.stringify((await skipExecute(shipmentRequestId).expect(400)).body)).toContain('승인된 OQC 생략 요청이 없습니다');
      await approve(approvalRequestId);

      const executed = await skipExecute(shipmentRequestId).expect(200);

      expect(executed.body.shippingInspectionStatusCode).toBe('PASSED');
      expect(await gate(shipmentRequestId)).toBe('PASSED');
      const oqc = await prisma.inspection_request.findUniqueOrThrow({ where: { inspection_request_id: BigInt(requestId) } });
      expect(oqc.status_code).toBe('SKIPPED');
      expect(await transitionsOf(lotId)).toEqual(['C27']);
      // 같은 승인을 두 번 쓰지 못한다 — 생략할 열린 의뢰가 없다.
      expect(JSON.stringify((await skipExecute(shipmentRequestId).expect(400)).body)).toContain('생략을 실행할 수 없습니다');
      // 생략된 의뢰에는 결과를 저장할 수 없다.
      await postConfirmed(requestId, { acceptedQty: 100, rejectedQty: 0 }, { overallJudgmentCode: 'ACCEPTED' }).expect(400);
    });

    it('⛔ 결재 대상 유형 SHIPMENT_REQUEST 로 자기 결재를 찾는다(W-04-03)', async () => {
      const { shipmentRequestId } = await newOqcRequest(itemWithoutAn);
      await skipRequest(shipmentRequestId).expect(202);

      const found = await request(app.getHttpServer())
        .get('/api/app/approval-requests')
        .query({ approvalTypeCode: 'OQC_SKIP', targetTypeCode: 'SHIPMENT_REQUEST', targetId: shipmentRequestId })
        .set('Cookie', cookie)
        .expect(200);

      expect(found.body.items).toHaveLength(1);
      expect(found.body.items[0].statusCode).toBe('PENDING');
      // 진행 중인 요청이 있으면 또 상신하지 못한다(코어).
      await skipRequest(shipmentRequestId).expect(400);
    });

    it('⛔ 판정이 끝난(확정) 출하작업지시는 생략을 요청할 수 없다', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithoutAn);
      await postConfirmed(requestId, { acceptedQty: 100, rejectedQty: 0 }, { overallJudgmentCode: 'ACCEPTED' }).expect(201);

      expect(JSON.stringify((await skipRequest(shipmentRequestId).expect(400)).body)).toContain('생략을 요청할 수 없습니다');
    });

    it('⛔ 피킹이 덜 끝났으면 승인돼도 실행이 400', async () => {
      const { shipmentRequestId } = await newOqcRequest(itemWithoutAn, { picked: false });
      const requested = await skipRequest(shipmentRequestId).expect(202);
      await approve(requested.body.approvalRequestId as number);

      expect(JSON.stringify((await skipExecute(shipmentRequestId).expect(400)).body)).toContain('피킹을 마친 뒤 생략을 실행하세요');
    });
  });

  /** 출하요청 편성(실제 API) — 검사 필수 라인 하나라 그 품목의 OQC 의뢰 하나가 선다(헤더 대상 · LOT 없음). */
  async function newOqcRequest(
    itemId: number,
    options: { picked?: boolean } = {},
  ): Promise<{ shipmentRequestId: number; requestId: number; lotId: bigint }> {
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
    const lotId = await pick(shipmentRequestId, itemId, options.picked === false ? 40 : 100);
    return { shipmentRequestId, requestId: Number(oqc.inspection_request_id), lotId };
  }

  /** 피킹 — 라인에 예약 한 줄을 심는다(`:pick` 은 재고·위치가 필요해 이 스위트의 관심 밖이다). 100 이면 완료(P = A). */
  async function pick(shipmentRequestId: number, itemId: number, qty: number): Promise<bigint> {
    const line = await prisma.shipment_request_line.findFirstOrThrow({ where: { shipment_request_id: BigInt(shipmentRequestId) } });
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${randomUUID().slice(0, 8)}`,
        item_id: BigInt(itemId),
        lot_type_code: 'PRODUCT',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: BigInt(uomId),
        source_type_code: 'WORK_ORDER',
        source_id: 0n,
        status_code: 'NORMAL',
      },
    });
    await prisma.inventory_reservation.create({
      data: {
        reservation_no: `${PREFIX}-RSV-${randomUUID().slice(0, 8)}`,
        reservation_type_code: 'SHIPMENT',
        source_document_type_code: 'SHIPMENT_REQUEST_LINE',
        source_document_id: line.shipment_request_line_id,
        item_id: BigInt(itemId),
        lot_id: lot.lot_id,
        warehouse_id: warehouseId,
        reserved_qty: qty,
        uom_id: BigInt(uomId),
        status_code: 'REGISTERED',
      },
    });
    return lot.lot_id;
  }

  const lotOf = async (lotId: bigint): Promise<string> =>
    (await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } })).status_code;

  const transitionsOf = async (lotId: bigint): Promise<string[]> =>
    (await prisma.lot_status_event.findMany({ where: { lot_id: lotId }, orderBy: { lot_status_event_id: 'asc' } })).map(
      (row) => row.transition_code,
    );

  function skipRequest(shipmentRequestId: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/shipment-requests/${shipmentRequestId}:request-oqc-skip`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ reason: '고객 승인 — 검사 없이 출하' });
  }

  function skipExecute(shipmentRequestId: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/shipment-requests/${shipmentRequestId}:skip-oqc`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key());
  }

  /** 결재함 상세의 ETag 는 `:approve` 가 쓰는 토큰이다. */
  async function approve(approvalRequestId: number): Promise<void> {
    const detail = await request(app.getHttpServer()).get(`/api/app/approval-requests/${approvalRequestId}`).set('Cookie', cookie).expect(200);
    await request(app.getHttpServer())
      .post(`/api/app/approval-requests/${approvalRequestId}:approve`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.headers.etag as string)
      .send({ comment: '생략 승인' })
      .expect(200);
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
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: 'OQC판정사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'OQC판정공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = plant.plant_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: 'OQC판정창고',
        warehouse_type_code: 'FINISHED_GOODS',
        management_level_code: 'WAREHOUSE',
      },
    });
    warehouseId = warehouse.warehouse_id;
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
    userId = user.app_user_id;
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
    const lots = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}-LOT-%'`;
    const approvals = `SELECT approval_request_id FROM app.approval_request WHERE approval_type_code = 'OQC_SKIP'`;
    for (const sql of [
      `DELETE FROM app.approval_step WHERE approval_request_id IN (${approvals})`,
      `DELETE FROM app.approval_request WHERE approval_type_code = 'OQC_SKIP'`,
      `DELETE FROM app.approval_route_step WHERE approval_route_id IN (SELECT approval_route_id FROM app.approval_route WHERE approval_type_code = 'OQC_SKIP')`,
      `DELETE FROM app.approval_route WHERE approval_type_code = 'OQC_SKIP'`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}-RSV-%'`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}-LOT-%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
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
