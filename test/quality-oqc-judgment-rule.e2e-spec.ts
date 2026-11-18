/**
 * 출하 OQC — 확정 저장이 닫힌 것과 OQC 생략(요청 → 결재 → 실행) (e2e · omf-all-around#126 · #119 · 장부 P-70·P-83).
 *
 * ⚠ 피처 010(omf-all-around#305)부터 출하 OQC 결과는 LOT 매칭·판정만으로 작성중에 쌓이고 출하 완료가 확정한다 — 확정 저장 경로의
 *   합격판정개수 변경 사유(#126)·피킹 전제·LOT 이력(C4·C6) 시험은 그 경로가 없어져 지웠다(`shipment-simplified.e2e-spec.ts` 가 새 흐름).
 * 생략: 결과가 하나도 없는 열린 의뢰만 생략하고, 실행은 피킹 완료를 요구하지 않는다(FR-012).
 * 피킹은 이 스위트의 관심 밖이라 예약 행을 직접 심는다(`pick`).
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
   * ⚠ 피처 010(omf-all-around#305)부터 출하 OQC 는 확정 버튼·확정 저장이 없다 — 결과는 LOT 매칭·판정만으로 작성중에 쌓이고 출하
   *   완료가 한꺼번에 확정한다(그 흐름은 `shipment-simplified.e2e-spec.ts`). 확정 시점에 걸던 합격판정개수 변경 사유(#126)·피킹
   *   전제·LOT 이력(C4·C6) 시험은 그 경로가 없어져 지웠다. 여기서는 확정 저장이 409 로 닫힌 것만 본다.
   */
  it('⛔ R-5 출하 OQC 의 확정 저장(statusCode=CONFIRMED)은 409 CONFIRMED_BY_SHIPMENT_COMPLETION · 결과 없음', async () => {
    const { requestId } = await newOqcRequest(itemWithAn);

    const response = await postConfirmed(requestId, { acceptedQty: 90, rejectedQty: 10 }, { overallJudgmentCode: 'ACCEPTED' }).expect(409);

    expect(response.body.code).toBe('CONFIRMED_BY_SHIPMENT_COMPLETION');
    expect(await prisma.inspection_result.count({ where: { inspection_request_id: BigInt(requestId) } })).toBe(0);
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
      // 생략된 의뢰에는 결과를 저장할 수 없다(작성중 저장도 — 피처 010).
      await postConfirmed(requestId, { acceptedQty: 100, rejectedQty: 0 }, { overallJudgmentCode: 'ACCEPTED', statusCode: 'DRAFT', matchedLotIds: [Number(lotId)] }).expect(400);
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

    it('⛔ FR-012 결과가 하나라도(작성중이어도) 있는 출하작업지시는 생략을 요청할 수 없다', async () => {
      const { shipmentRequestId, requestId } = await newOqcRequest(itemWithoutAn);
      // 피처 010 — 결과는 작성중으로 쌓인다. 이 스위트는 피킹 LOT 행 없이 예약만 심으므로 결과 행을 직접 둔다.
      const worker = await prisma.worker.findFirstOrThrow({ where: { app_user_id: userId } });
      await prisma.inspection_result.create({ data: {
        inspection_result_no: `${PREFIX}-IRS-${randomUUID().slice(0, 8)}`, inspection_request_id: BigInt(requestId), inspection_round: 1,
        inspected_qty: 100, accepted_qty: 100, uom_id: BigInt(uomId), overall_judgment_code: 'ACCEPTED', inspector_id: worker.worker_id,
        inspected_at: new Date(`${DAY}T03:00:00.000Z`), status_code: 'DRAFT', idempotency_key: key(),
      } });

      expect(JSON.stringify((await skipRequest(shipmentRequestId).expect(400)).body)).toContain('생략을 요청할 수 없습니다');
    });

    it('⭐ FR-012·Q16 피킹이 덜 끝나도 승인 뒤 실행된다 — 지금 피킹된 LOT 에 C27 이 남는다(피처 010)', async () => {
      const { shipmentRequestId, lotId } = await newOqcRequest(itemWithoutAn, { picked: false });
      const requested = await skipRequest(shipmentRequestId).expect(202);
      await approve(requested.body.approvalRequestId as number);

      await skipExecute(shipmentRequestId).expect(200);

      expect(await transitionsOf(lotId)).toEqual(['C27']);
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
