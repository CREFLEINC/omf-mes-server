/**
 * ERP W/O 수신 시 계획 자동 작성·확정(장부 P-67) — 등록 `POST`·ERP 받기 뒤 자동 계획, `:auto-plan` 재시도,
 * 목록·상세의 `autoPlan` 과 `autoPlanStatus` 필터. ERP 받기는 중계 DB 대신 흉내낸 중계로 실제 회차를 돈다.
 *
 * ⚠ 자동 계획이 채번한 `plan_no`·`work_order_no` 는 `PREFIX` 로 시작하지 않는다 — 정리는 오더 관계로 좁힌다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { productionOrderTable } from '../src/integration/erp/apply/production-order.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { PRODUCTION_ORDER, RelayRow } from '../src/integration/erp/relay-tables';
import { AutoPlanService } from '../src/planning/production-order/auto-plan.service';
import { ProductionPlanService } from '../src/planning/production-plan/production-plan.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-ap74-probe';
const PASSWORD = 'AP74-검사-비밀번호';
const PREFIX = 'AP74';
const ROLE = 'E2E_AP74';
/** ERP W/O 목록 권한만 — 재시도 버튼이 그 화면에 있다. */
const LIST_ONLY_ID = 'e2e-ap74-list-only';
const LIST_ONLY_ROLE = 'E2E_AP74_LIST_ONLY';
/** 권한이 한 줄도 없는 계정. */
const STRANGER_ID = 'e2e-ap74-stranger';
const STRANGER_ROLE = 'E2E_AP74_STRANGER';
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const ERP_SOURCE = { ...PRODUCTION_ORDER, interfaceCode: 'E2E-AP74-PRODORD-RECV' };

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('ERP W/O 자동 계획 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId = BigInt(0);
  let businessUnitId = BigInt(0);
  let uomId = BigInt(0);
  let uomCode = '';
  let lineId = BigInt(0);
  let equipmentId = BigInt(0);
  let moldId = BigInt(0);
  const items = { ok: BigInt(0), moldOnly: BigInt(0), noRouting: BigInt(0), ambiguous: BigInt(0) };

  let okOrderId = 0;
  let moldOrderId = 0;
  let noRoutingOrderId = 0;
  let ambiguousOrderId = 0;
  let partialOrderId = 0;
  let erpChangedOrderId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeCatalog();
    await makeUser();
    cookie = await login(LOGIN_ID);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('등록 뒤 자동 계획', () => {
    it('1. 정할 수 있으면 계획을 세우고 확정해 W/O 에 설비·금형·라인이 선다', async () => {
      const response = await postOrder('OK', items.ok, 120).expect(201);
      okOrderId = response.body.productionOrderId as number;

      expect(response.body.autoPlan).toEqual({ status: 'DONE', reasons: [] });
      expect(validator('POST /planning/production-orders', 201)(response.body)).toBe(true);

      const plans = await plansOf(okOrderId);
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ status_code: 'CONFIRMED', planned_line_id: null, uom_id: uomId });
      expect(Number(plans[0].planned_qty)).toBe(120);
      expect(plans[0].plan_date.toISOString().slice(0, 10)).toBe(localToday());

      const [injection, assembly] = await workOrdersOf(plans[0].production_plan_id);
      expect(injection).toMatchObject({ planned_equipment_id: equipmentId, planned_mold_id: moldId, production_line_id: lineId });
      expect(assembly).toMatchObject({ planned_equipment_id: null, planned_mold_id: null });
    });

    it('2. 금형만 매핑돼 라인을 모르면 작성중 계획만 두고 LINE_UNKNOWN 이다', async () => {
      const response = await postOrder('MOLD', items.moldOnly, 80).expect(201);
      moldOrderId = response.body.productionOrderId as number;

      expect(response.body.autoPlan).toEqual({ status: 'NEEDS_REVIEW', reasons: ['LINE_UNKNOWN', 'PLAN_NOT_CONFIRMED'] });
      const plans = await plansOf(moldOrderId);
      expect(plans.map((plan) => plan.status_code)).toEqual(['DRAFT']);
      expect(await workOrdersOf(plans[0].production_plan_id)).toEqual([]);
    });

    it('3. 쓸 수 있는 Routing 이 없으면 계획을 세우지 않고 ROUTING_MISSING 이다', async () => {
      const response = await postOrder('NORT', items.noRouting, 50).expect(201);
      noRoutingOrderId = response.body.productionOrderId as number;

      expect(response.body.autoPlan).toEqual({ status: 'NEEDS_REVIEW', reasons: ['ROUTING_MISSING'] });
      expect(await plansOf(noRoutingOrderId)).toEqual([]);
    });

    it('4. 자동 계획이 실패해도 등록은 201 이고, :auto-plan 으로 다시 세운다', async () => {
      const spy = jest.spyOn(app.get(ProductionPlanService), 'create').mockRejectedValueOnce(new Error('자동 계획 강제 실패'));
      const response = await postOrder('FAIL', items.ok, 30).expect(201);
      spy.mockRestore();
      const orderId = response.body.productionOrderId as number;

      // 시도는 했으나 계획이 없고 막는 것도 없다 — 사유 없는 확인 필요.
      expect(response.body.autoPlan).toEqual({ status: 'NEEDS_REVIEW', reasons: [] });
      expect(await plansOf(orderId)).toEqual([]);

      const retry = await autoPlan(orderId).expect(200);
      expect(retry.body).toMatchObject({ productionOrderId: orderId, outcome: 'CONFIRMED', reasons: [] });
      expect((await plansOf(orderId)).map((plan) => plan.status_code)).toEqual(['CONFIRMED']);
    });
  });

  describe('수신 때 건너뛰는 오더', () => {
    it('4-1. 납기가 공장 현지 오늘보다 앞이면 자동 계획하지 않고 상태도 없다 — :auto-plan 으로는 세운다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-orders')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderNo: `${PREFIX}-PO-LATE`, plantId: Number(plantId), itemId: Number(items.ok), orderQty: 15, dueDate: dayBefore(localToday()) })
        .expect(201);
      const orderId = response.body.productionOrderId as number;

      expect(response.body.autoPlan).toBeNull();
      expect(await plansOf(orderId)).toEqual([]);
      expect((await prisma.production_order.findUniqueOrThrow({ where: { production_order_id: BigInt(orderId) } })).auto_plan_attempted_at).toBeNull();

      const retry = await autoPlan(orderId).expect(200);
      expect(retry.body).toMatchObject({ outcome: 'CONFIRMED', reasons: [] });
    });

    it('4-2. 납기가 오늘이면 자동 계획한다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/planning/production-orders')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ productionOrderNo: `${PREFIX}-PO-TODAY`, plantId: Number(plantId), itemId: Number(items.ok), orderQty: 15, dueDate: localToday() })
        .expect(201);

      expect(response.body.autoPlan).toEqual({ status: 'DONE', reasons: [] });
    });
  });

  describe(':auto-plan', () => {
    it('5. 라인을 모르는 작성중 계획은 그대로 DRAFT 다', async () => {
      const response = await autoPlan(moldOrderId).expect(200);
      const [draft] = await plansOf(moldOrderId);

      expect(response.body).toEqual({
        productionOrderId: moldOrderId,
        outcome: 'DRAFT',
        productionPlanId: Number(draft.production_plan_id),
        reasons: ['LINE_UNKNOWN', 'PLAN_NOT_CONFIRMED'],
      });
      expect(validator('POST /planning/production-orders/{productionOrderId}:auto-plan')(response.body)).toBe(true);
    });

    it('6. 계획 라인을 고른 뒤 다시 하면 그 작성중 계획을 확정한다', async () => {
      const [draft] = await plansOf(moldOrderId);
      await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${draft.production_plan_id}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', String(draft.version_no))
        .send({ plannedLineId: Number(lineId) })
        .expect(200);

      const response = await autoPlan(moldOrderId).expect(200);

      expect(response.body).toEqual({
        productionOrderId: moldOrderId,
        outcome: 'CONFIRMED',
        productionPlanId: Number(draft.production_plan_id),
        reasons: [],
      });
      const [workOrder] = await workOrdersOf(draft.production_plan_id);
      expect(workOrder).toMatchObject({ production_line_id: lineId, planned_mold_id: moldId });
    });

    it('7. 이미 수량을 채운 오더는 바꾸지 않고 CONFIRMED 다', async () => {
      const [plan] = await plansOf(okOrderId);
      const before = await workOrdersOf(plan.production_plan_id);

      const response = await autoPlan(okOrderId).expect(200);

      expect(response.body).toEqual({ productionOrderId: okOrderId, outcome: 'CONFIRMED', productionPlanId: Number(plan.production_plan_id), reasons: [] });
      expect(await plansOf(okOrderId)).toHaveLength(1);
      expect(await workOrdersOf(plan.production_plan_id)).toHaveLength(before.length);
    });

    it('8. 정할 수 없으면 NOT_PLANNED 와 사유를 낸다', async () => {
      const response = await autoPlan(noRoutingOrderId).expect(200);

      expect(response.body).toEqual({ productionOrderId: noRoutingOrderId, outcome: 'NOT_PLANNED', productionPlanId: null, reasons: ['ROUTING_MISSING'] });
      expect(validator('POST /planning/production-orders/{productionOrderId}:auto-plan')(response.body)).toBe(true);
    });

    it('9. 없는 ERP W/O 는 404', async () => {
      await autoPlan(999999999).expect(404);
    });

    it('9-1. 같은 오더에 동시에 두 번 불러도 계획은 하나다', async () => {
      const order = await insertOrder('RACE', items.ok, 25);
      const orderId = Number(order.production_order_id);

      const [first, second] = await Promise.all([autoPlan(orderId), autoPlan(orderId)]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect([first.body.outcome, second.body.outcome]).toEqual(['CONFIRMED', 'CONFIRMED']);
      expect(first.body.productionPlanId).toBe(second.body.productionPlanId);
      expect(await plansOf(orderId)).toHaveLength(1);
    });

    it('9-2. ERP W/O 목록 권한(W-02-01)만으로 부를 수 있고, 권한이 없으면 403', async () => {
      const listOnly = await login(LIST_ONLY_ID);
      await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${noRoutingOrderId}:auto-plan`)
        .set('Cookie', listOnly)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(200);

      const stranger = await login(STRANGER_ID);
      await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${noRoutingOrderId}:auto-plan`)
        .set('Cookie', stranger)
        .send({})
        .expect(403);
    });
  });

  describe('ERP 받기 뒤 자동 계획', () => {
    it('14. 처음 받은 ERP W/O 는 반영이 커밋된 뒤 계획을 세우고 확정한다', async () => {
      const result = await receiveFromErp([erpRow(1, 'ERP1', 1, 60)]);

      expect(result).toMatchObject({ applied: 1, failed: 0 });
      const order = await prisma.production_order.findUniqueOrThrow({ where: { production_order_no: `${PREFIX}-PO-ERP1` } });
      const plans = await plansOf(Number(order.production_order_id));
      expect(plans.map((plan) => [plan.status_code, Number(plan.planned_qty), plan.created_by])).toEqual([['CONFIRMED', 60, null]]);
      expect(await workOrdersOf(plans[0].production_plan_id)).not.toEqual([]);
    });

    it('15. 이미 있는 ERP W/O 의 변경은 계획을 세우지 않는다 — 확인 흐름이 맡는다', async () => {
      const existing = await prisma.production_order.create({
        data: {
          production_order_no: `${PREFIX}-PO-ERP2`,
          erp_order_no: `${PREFIX}-PO-ERP2`,
          business_unit_id: businessUnitId,
          plant_id: plantId,
          item_id: items.ok,
          order_qty: 70,
          uom_id: uomId,
          status_code: 'RECEIVED',
        },
      });

      erpChangedOrderId = Number(existing.production_order_id);
      const result = await receiveFromErp([erpRow(2, 'ERP2', 2, 90)]);

      expect(result).toMatchObject({ applied: 1, failed: 0 });
      expect((await prisma.production_order.findUniqueOrThrow({ where: { production_order_id: existing.production_order_id } })).status_code).toBe('UPDATED');
      expect(await plansOf(Number(existing.production_order_id))).toEqual([]);
    });
  });

  describe('목록·상세의 autoPlan', () => {
    beforeAll(async () => {
      // 수신 경로를 거치지 않은 오더 — 이 기능 전에 받은 오더와 같다(시도 시각이 비어 있다).
      ambiguousOrderId = Number((await insertOrder('AMB', items.ambiguous, 10)).production_order_id);
      const partial = await insertOrder('PART', items.ok, 100);
      partialOrderId = Number(partial.production_order_id);
      const [bom, routing] = await Promise.all([
        prisma.bom.findFirstOrThrow({ where: { parent_item_id: items.ok, is_default: true } }),
        prisma.routing.findFirstOrThrow({ where: { item_id: items.ok } }),
      ]);
      await prisma.production_plan.create({
        data: {
          production_order_id: partial.production_order_id,
          plan_no: `${PREFIX}-PP-PART`,
          plan_date: new Date('2026-10-01T00:00:00.000Z'),
          planned_qty: 40,
          uom_id: uomId,
          bom_id: bom.bom_id,
          routing_id: routing.routing_id,
          status_code: 'CONFIRMED',
        },
      });
    });

    it('10. 시도한 적 없고 계획도 없는 오더는 autoPlan 이 null 이다 — 계획이 있으면 시도 없이도 상태가 선다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${ambiguousOrderId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.autoPlan).toBeNull();
      expect(validator('GET /planning/production-orders/{productionOrderId}')(response.body)).toBe(true);
    });

    it('10-1. 옛 오더에 :auto-plan 을 부르면 시도한 것이 되어 상태가 선다', async () => {
      const response = await autoPlan(ambiguousOrderId).expect(200);

      expect(response.body).toEqual({ productionOrderId: ambiguousOrderId, outcome: 'NOT_PLANNED', productionPlanId: null, reasons: ['ROUTING_AMBIGUOUS'] });
      const order = await prisma.production_order.findUniqueOrThrow({ where: { production_order_id: BigInt(ambiguousOrderId) } });
      expect(order.auto_plan_attempted_at).toBeInstanceOf(Date);
      // 판을 올리지 않는다 — 확인의 If-Match 를 낡게 만들지 않게.
      expect(order.version_no).toBe(1);
    });

    it('10-2. 목록 행마다 autoPlan 을 싣는다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ plantId: Number(plantId), size: 100 })
        .set('Cookie', cookie)
        .expect(200);

      const byId = new Map(
        (response.body.items as { productionOrderId: number; autoPlan: unknown }[]).map((item) => [item.productionOrderId, item.autoPlan]),
      );
      expect(byId.get(okOrderId)).toEqual({ status: 'DONE', reasons: [] });
      expect(byId.get(moldOrderId)).toEqual({ status: 'DONE', reasons: [] });
      expect(byId.get(noRoutingOrderId)).toEqual({ status: 'NEEDS_REVIEW', reasons: ['ROUTING_MISSING'] });
      expect(byId.get(ambiguousOrderId)).toEqual({ status: 'NEEDS_REVIEW', reasons: ['ROUTING_AMBIGUOUS'] });
      expect(byId.get(partialOrderId)).toEqual({ status: 'NEEDS_REVIEW', reasons: ['QTY_REMAINING'] });
      expect(byId.get(erpChangedOrderId)).toBeNull();
      expect(validator('GET /planning/production-orders')(response.body)).toBe(true);
    });

    it('11. autoPlanStatus 로 거른다', async () => {
      const idsOf = async (autoPlanStatus: string): Promise<number[]> => {
        const response = await request(app.getHttpServer())
          .get('/api/planning/production-orders')
          .query({ plantId: Number(plantId), autoPlanStatus, size: 100 })
          .set('Cookie', cookie)
          .expect(200);
        return (response.body.items as { productionOrderId: number }[]).map((item) => item.productionOrderId).sort((a, b) => a - b);
      };

      const review = await idsOf('NEEDS_REVIEW');
      // 상태가 없는 오더(ERP 변경만 받은 오더·납기 지난 채 받은 오더)는 어느 쪽에도 들지 않는다.
      expect(review).toEqual([noRoutingOrderId, ambiguousOrderId, partialOrderId].sort((a, b) => a - b));
      const done = await idsOf('DONE');
      expect(done).toEqual(expect.arrayContaining([okOrderId, moldOrderId]));
      expect(done).not.toContain(erpChangedOrderId);
    });

    it('12. 모르는 autoPlanStatus 는 400', async () => {
      await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ autoPlanStatus: 'MAYBE' })
        .set('Cookie', cookie)
        .expect(400);
    });

    it('13. 상세도 autoPlan 을 싣는다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${ambiguousOrderId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.autoPlan).toEqual({ status: 'NEEDS_REVIEW', reasons: ['ROUTING_AMBIGUOUS'] });
      expect(validator('GET /planning/production-orders/{productionOrderId}')(response.body)).toBe(true);
    });
  });

  function postOrder(suffix: string, itemId: bigint, orderQty: number): request.Test {
    return request(app.getHttpServer())
      .post('/api/planning/production-orders')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ productionOrderNo: `${PREFIX}-PO-${suffix}`, plantId: Number(plantId), itemId: Number(itemId), orderQty });
  }

  function autoPlan(productionOrderId: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/planning/production-orders/${productionOrderId}:auto-plan`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({});
  }

  function insertOrder(suffix: string, itemId: bigint, orderQty: number) {
    return prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-${suffix}`,
        business_unit_id: businessUnitId,
        plant_id: plantId,
        item_id: itemId,
        order_qty: orderQty,
        uom_id: uomId,
        status_code: 'RECEIVED',
      },
    });
  }

  /** 중계 DB 를 흉내낸다 — 한 번 읽고 확인 표시를 받는다. 반영·커밋 뒤 처리는 실제 회차가 한다. */
  async function receiveFromErp(rows: RelayRow[]) {
    const pending = [...rows];
    const relay = {
      fetchPending: async () => pending.splice(0),
      ack: async () => undefined,
      writeError: async () => undefined,
    };
    const autoPlans = app.get(AutoPlanService);
    const table = { ...productionOrderTable((id) => autoPlans.planReceived(Number(id), undefined)), source: ERP_SOURCE };
    return new InboundCycle(prisma, relay as unknown as RelayClient).run(table);
  }

  function erpRow(id: number, suffix: string, seq: number, qty: number): RelayRow {
    return {
      MES_INF_ID: id,
      PLANT_CD: `${PREFIX}-P`,
      PRODT_ORDER_NO: `${PREFIX}-PO-${suffix}`,
      ITEM_CD: `${PREFIX}-IT-ok`,
      IF_SEQ: seq,
      CREATE_TYPE: 'A',
      OPR_NO: '010',
      PLAN_START_DT: '2026-10-21',
      PRODT_ORDER_QTY: qty,
      BASE_UNIT: uomCode,
      MES_APPLY_FLAG: 'N',
    };
  }

  function plansOf(productionOrderId: number) {
    return prisma.production_plan.findMany({ where: { production_order_id: BigInt(productionOrderId) }, orderBy: { production_plan_id: 'asc' } });
  }

  function workOrdersOf(productionPlanId: bigint) {
    return prisma.work_order.findMany({
      where: { production_plan_id: productionPlanId },
      orderBy: { routing_operation: { operation_seq: 'asc' } },
    });
  }

  function dayBefore(date: string): string {
    return new Date(new Date(`${date}T00:00:00.000Z`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function localToday(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  async function makeCatalog(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '자동계획검사법인', country_code: 'VN', timezone_code: TIMEZONE },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '자동계획검사사업부' },
    });
    businessUnitId = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '자동계획검사공장',
        timezone_code: TIMEZONE,
      },
    });
    plantId = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    uomCode = uom.uom_code;
    lineId = (await prisma.production_line.create({ data: { plant_id: plantId, line_code: `${PREFIX}-LN`, line_name: '자동계획검사라인' } }))
      .production_line_id;
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    equipmentId = (
      await prisma.equipment.create({
        data: { plant_id: plantId, equipment_code: `${PREFIX}-EQ`, equipment_name: '자동계획사출기', equipment_type_code: 'PRESS', status_code: 'IN_SERVICE', production_line_id: lineId },
      })
    ).equipment_id;
    moldId = (
      await prisma.mold.create({
        data: { plant_id: plantId, mold_code: `${PREFIX}-MOLD`, mold_name: '자동계획금형', status_code: 'IN_SERVICE', tool_type_code: 'MOLD' },
      })
    ).mold_id;

    const makeItem = async (key: keyof typeof items): Promise<bigint> => {
      const item = await prisma.item.create({
        data: { item_code: `${PREFIX}-IT-${key}`, item_name: `자동계획검사품목-${key}`, item_type_code: 'FINISHED_GOODS', base_uom_id: uomId, lot_controlled: true },
      });
      await prisma.bom.create({
        data: {
          parent_item_id: item.item_id,
          bom_code: `${PREFIX}-BOM-${key}`,
          bom_version: 1,
          status_code: 'CONFIRMED',
          is_default: true,
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          base_qty: 1,
          base_uom_id: uomId,
        },
      });
      return item.item_id;
    };
    const makeRouting = async (itemId: bigint, code: string, operations: { equipment: boolean; mold: boolean }[]): Promise<void> => {
      const routing = await prisma.routing.create({ data: { item_id: itemId, routing_code: `${PREFIX}-RT-${code}`, routing_version: 1, status_code: 'CONFIRMED' } });
      await prisma.routing_operation.createMany({
        data: operations.map((need, index) => ({
          routing_id: routing.routing_id,
          operation_seq: (index + 1) * 10,
          process_id: process.process_id,
          operation_name: `공정${(index + 1) * 10}`,
          equipment_required: need.equipment,
          mold_required: need.mold,
        })),
      });
    };

    items.ok = await makeItem('ok');
    await makeRouting(items.ok, 'ok', [{ equipment: true, mold: true }, { equipment: false, mold: false }]);
    await prisma.item_resource_map.create({ data: { plant_id: plantId, item_id: items.ok, equipment_id: equipmentId, mold_id: moldId, is_default: true } });

    items.moldOnly = await makeItem('moldOnly');
    await makeRouting(items.moldOnly, 'mold', [{ equipment: true, mold: true }]);
    await prisma.item_resource_map.create({ data: { plant_id: plantId, item_id: items.moldOnly, mold_id: moldId, is_default: true } });

    items.noRouting = await makeItem('noRouting');

    items.ambiguous = await makeItem('ambiguous');
    await makeRouting(items.ambiguous, 'amb1', [{ equipment: true, mold: false }]);
    await makeRouting(items.ambiguous, 'amb2', [{ equipment: true, mold: false }]);
  }

  async function makeUser(): Promise<void> {
    const accounts: [string, string, string[]][] = [
      [LOGIN_ID, ROLE, ['W-02-01', 'W-02-02']],
      [LIST_ONLY_ID, LIST_ONLY_ROLE, ['W-02-01']],
      // 권한 0줄짜리 역할 — 「역할 없음」이 아니라 「권한 없음」이라야 403 이 권한 판정이다.
      [STRANGER_ID, STRANGER_ROLE, []],
    ];
    for (const [loginId, roleCode, permissions] of accounts) {
      const user = await prisma.app_user.create({
        data: { login_id: loginId, user_name: '자동계획검사', status_code: 'EMPLOYED' },
      });
      await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: '자동계획검사용' } });
      if (permissions.length > 0) {
        await prisma.role_permission.createMany({
          data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
        });
      }
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 자가 치유 `deleteMany`(역순). `beforeAll`·`afterAll` 둘 다 부른다. */
  async function cleanup(): Promise<void> {
    const scope = { production_order: { production_order_no: { startsWith: PREFIX } } };
    const plans = await prisma.production_plan.findMany({ where: scope, select: { production_plan_id: true } });
    const workOrders = await prisma.work_order.findMany({
      where: { production_plan_id: { in: plans.map((row) => row.production_plan_id) } },
      select: { work_order_id: true },
    });
    const workOrderIds = workOrders.map((row) => row.work_order_id);
    await prisma.work_order_dependency.deleteMany({
      where: { OR: [{ predecessor_work_order_id: { in: workOrderIds } }, { successor_work_order_id: { in: workOrderIds } }] },
    });
    await prisma.work_order.deleteMany({ where: { work_order_id: { in: workOrderIds } } });
    await prisma.production_plan.deleteMany({ where: scope });
    await prisma.integration_message.deleteMany({ where: { interface_code: ERP_SOURCE.interfaceCode } });
    await prisma.production_order_change_field.deleteMany({ where: scope });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.item_resource_map.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.mold.deleteMany({ where: { mold_code: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    for (const loginId of [LOGIN_ID, LIST_ONLY_ID, STRANGER_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!target) continue;
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const roleCode of [ROLE, LIST_ONLY_ROLE, STRANGER_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: roleCode } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
