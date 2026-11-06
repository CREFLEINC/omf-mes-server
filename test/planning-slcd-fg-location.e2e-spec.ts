/**
 * ERP W/O 의 입고 창고(SL_CD)를 MES W/O 완제품 위치로 적용 (e2e).
 *
 * 제안 조회·제안 확정·직접 확정·자동 계획·MES W/O 수정이 같은 판정을 쓴다 — SL_CD 와 코드가 같은 창고의 입고 위치
 * (나뉘지 않은 창고는 창고 전체, 나뉜 창고는 적치 대기). 연결에 실패하면 라인 기본값으로 대체하지 않고 사유를 구분해 막는다.
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
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

/** SL_CD 는 7자 이하다 — 창고 코드가 곧 SL_CD 라 접두어를 짧게 둔다. */
const PREFIX = 'SLF244';
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const PROPOSALS = '/api/planning/production-orders:plan-proposals';

function validator(pointer: string): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}
const response200 = (path: string, method: string): string =>
  `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/200/content/application~1json/schema`;

interface ProposalWorkOrder {
  routingOperationId: number;
  productionLineId: number | null;
  plannedEquipmentId: number | null;
  plannedMoldId: number | null;
  defaultWipLocationId: number | null;
  defaultFgLocationId: number | null;
  defaultFgLocationSource: string;
  defaultScrapLocationId: number | null;
  issues: { severity: string; code: string; field?: string }[];
}
interface Proposal {
  productionOrderId: number;
  status: string;
  reasons: { code: string; category: string }[];
  basis: Record<string, string>;
  erpStorage: {
    erpStorageLocationCode: string | null;
    warehouse: { id: number; code: string; name: string } | null;
    location: { id: number; code: string; name: string } | null;
    reasonCode: string | null;
  };
  plans: { proposalPlanKey: string; planDate: string; proposedQty: number; bomId: number; routingId: number; plannedLineId: number | null; workOrders: ProposalWorkOrder[] }[];
}

describe('ERP W/O 입고 창고(SL_CD) → 완제품 위치 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const id: Record<string, bigint> = {};
  const wh: Record<string, { id: bigint; whole: bigint; staging: bigint; zone: bigint }> = {};
  const planStart = shiftDays(localToday(), 3);
  let orderSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const propose = (orderId: bigint) =>
    request(app.getHttpServer()).get(PROPOSALS).query({ productionOrderIds: String(orderId) }).set('Cookie', cookie);
  const proposalOf = async (orderId: bigint): Promise<Proposal> => ((await propose(orderId).expect(200)).body as { items: Proposal[] }).items[0];
  const confirm = (orderId: bigint, body: unknown) =>
    request(app.getHttpServer()).post(`/api/planning/production-orders/${orderId}:confirm-plan-proposal`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send(body as object);

  function bodyOf(proposal: Proposal, override: Partial<Record<'defaultWipLocationId' | 'defaultFgLocationId' | 'defaultScrapLocationId', number>> = {}) {
    return {
      basis: proposal.basis,
      plans: proposal.plans.map((plan) => ({
        proposalPlanKey: plan.proposalPlanKey, planDate: plan.planDate, plannedQty: plan.proposedQty,
        bomId: plan.bomId, routingId: plan.routingId, plannedLineId: plan.plannedLineId,
        workOrders: plan.workOrders.map((workOrder) => ({
          routingOperationId: workOrder.routingOperationId,
          productionLineId: workOrder.productionLineId,
          plannedEquipmentId: workOrder.plannedEquipmentId,
          plannedMoldId: workOrder.plannedMoldId,
          defaultWipLocationId: override.defaultWipLocationId ?? workOrder.defaultWipLocationId ?? Number(id.locWip),
          defaultFgLocationId: override.defaultFgLocationId ?? workOrder.defaultFgLocationId ?? Number(id.locFg),
          defaultScrapLocationId: override.defaultScrapLocationId ?? workOrder.defaultScrapLocationId ?? Number(id.locScrap),
        })),
      })),
    };
  }

  /** 오더 하나 — 품목마다 BOM·Routing(공정 둘, 같은 설비)이 있어 W/O 가 둘 선다. */
  async function makeOrder(slCd: string | null, itemId: bigint = id.item): Promise<bigint> {
    orderSeq += 1;
    return (await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-O${orderSeq}`, business_unit_id: id.unit, plant_id: id.plant, item_id: itemId, order_qty: 100, uom_id: id.uom,
      status_code: 'RECEIVED', planned_start_date: new Date(`${planStart}T00:00:00.000Z`), erp_storage_location_code: slCd,
    } })).production_order_id;
  }

  const fgOfWorkOrders = async (orderId: bigint): Promise<(bigint | null)[]> =>
    (await prisma.work_order.findMany({ where: { production_plan: { production_order_id: orderId } }, select: { default_fg_location_id: true }, orderBy: { work_order_id: 'asc' } }))
      .map((row) => row.default_fg_location_id);

  describe('제안 조회', () => {
    it('유효한 SL_CD — 같은 공장의 정확한 창고와 그 「창고 전체」가 모든 공정 W/O 의 완제품 위치다(라인 기본값을 덮는다)', async () => {
      const orderId = await makeOrder(`${PREFIX}A`);
      const response = await propose(orderId).expect(200);
      expect(validator(response200('/planning/production-orders:plan-proposals', 'get'))(response.body)).toBe(true);
      const proposal = (response.body as { items: Proposal[] }).items[0];

      expect(proposal.status).toBe('CONFIRMABLE');
      expect(proposal.erpStorage).toEqual({
        erpStorageLocationCode: `${PREFIX}A`, warehouse: { id: Number(wh.A.id), code: `${PREFIX}A`, name: `${PREFIX} 완제품 A` },
        location: expect.objectContaining({ id: Number(wh.A.whole) }), reasonCode: null,
      });
      const workOrders = proposal.plans[0].workOrders;
      expect(workOrders).toHaveLength(2);
      for (const workOrder of workOrders) {
        expect(workOrder).toMatchObject({ defaultFgLocationId: Number(wh.A.whole), defaultFgLocationSource: 'ERP_STORAGE_LOCATION', issues: [] });
        expect(workOrder.defaultWipLocationId).toBe(Number(id.locWip));
      }
    });

    it('나뉜 창고는 「적치 대기」를 쓴다', async () => {
      const proposal = await proposalOf(await makeOrder(`${PREFIX}B`));

      expect(proposal.erpStorage.location).toMatchObject({ id: Number(wh.B.staging) });
      expect(proposal.plans[0].workOrders[0]).toMatchObject({ defaultFgLocationId: Number(wh.B.staging), defaultFgLocationSource: 'ERP_STORAGE_LOCATION' });
    });

    it.each([
      ['미매핑(코드가 같은 MES 창고 없음)', `${PREFIX}Z`, 'FG_WAREHOUSE_UNMAPPED'],
      ['비활성 창고', `${PREFIX}C`, 'FG_WAREHOUSE_INACTIVE'],
      ['다른 공장 창고', `${PREFIX}D`, 'FG_WAREHOUSE_OTHER_PLANT'],
      ['자재 창고', `${PREFIX}E`, 'FG_WAREHOUSE_NOT_ALLOWED'],
      ['불량 창고', `${PREFIX}F`, 'FG_WAREHOUSE_NOT_ALLOWED'],
      ['외부 창고', `${PREFIX}G`, 'FG_WAREHOUSE_NOT_ALLOWED'],
    ])('%s — 라인 기본값으로 대체하지 않고 구분된 사유로 막는다', async (_name, slCd, reason) => {
      const proposal = await proposalOf(await makeOrder(slCd));

      expect(proposal.status).toBe('NEEDS_INPUT');
      expect(proposal.reasons).toEqual([{ code: reason, category: 'BLOCKED' }]);
      // 분류는 표시용이다 — 제안 불가(빈 plans)가 아니라 계획·4M 은 그대로 나온다.
      expect(proposal.plans).toHaveLength(1);
      expect(proposal.erpStorage).toMatchObject({ erpStorageLocationCode: slCd, warehouse: null, location: null, reasonCode: reason });
      // 라인에 기본 완제품 위치가 있어도 쓰지 않는다.
      for (const workOrder of proposal.plans[0].workOrders) {
        expect(workOrder).toMatchObject({ defaultFgLocationId: null, defaultFgLocationSource: 'NONE' });
        expect(workOrder.issues.map((issue) => [issue.code, issue.field])).toEqual([[reason, 'defaultFgLocationId']]);
      }
    });

    it('SL_CD 가 없는 오더 — 라인 기본 완제품 위치를 쓰고 출처를 「라인 기본값」으로 낸다', async () => {
      const proposal = await proposalOf(await makeOrder(null));

      expect(proposal.status).toBe('CONFIRMABLE');
      expect(proposal.erpStorage).toEqual({ erpStorageLocationCode: null, warehouse: null, location: null, reasonCode: null });
      expect(proposal.plans[0].workOrders[0]).toMatchObject({ defaultFgLocationId: Number(id.locFg), defaultFgLocationSource: 'LINE_DEFAULT' });
    });

    it('SL_CD 도 라인 기본값도 없으면 위치 입력이 필요하다', async () => {
      const proposal = await proposalOf(await makeOrder(null, id.itemNoDefault));

      expect(proposal.reasons).toEqual([{ code: 'WORK_ORDER_LOCATION_REQUIRED', category: 'INPUT' }]);
      expect(proposal.plans[0].workOrders[0]).toMatchObject({ defaultFgLocationId: null, defaultFgLocationSource: 'NONE' });
    });
  });

  describe('제안 확정', () => {
    it('제안 그대로 확정하면 모든 공정 W/O 가 ERP 입고 위치를 갖는다', async () => {
      const orderId = await makeOrder(`${PREFIX}B`);
      await confirm(orderId, bodyOf(await proposalOf(orderId))).expect(200);

      expect(await fgOfWorkOrders(orderId)).toEqual([wh.B.staging, wh.B.staging]);
    });

    it('다른 창고의 위치를 넣으면 400 FG_LOCATION_OUTSIDE_WAREHOUSE — 칸은 본문 경로다', async () => {
      const orderId = await makeOrder(`${PREFIX}A`);
      const proposal = await proposalOf(orderId);

      const response = await confirm(orderId, bodyOf(proposal, { defaultFgLocationId: Number(id.locFg) })).expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: 'plans[0].workOrders[0].defaultFgLocationId', code: 'FG_LOCATION_OUTSIDE_WAREHOUSE' }),
        expect.objectContaining({ scope: 'field', field: 'plans[0].workOrders[1].defaultFgLocationId', code: 'FG_LOCATION_OUTSIDE_WAREHOUSE' }),
      ]);
      expect(await fgOfWorkOrders(orderId)).toEqual([]);
    });

    it('같은 창고의 다른 위치는 받는다', async () => {
      const orderId = await makeOrder(`${PREFIX}B`);
      await confirm(orderId, bodyOf(await proposalOf(orderId), { defaultFgLocationId: Number(wh.B.zone) })).expect(200);

      expect(await fgOfWorkOrders(orderId)).toEqual([wh.B.zone, wh.B.zone]);
    });

    it('연결 실패 오더는 어떤 위치를 넣어도 그 사유로 400 이다', async () => {
      const orderId = await makeOrder(`${PREFIX}Z`);
      const response = await confirm(orderId, bodyOf(await proposalOf(orderId))).expect(400);

      expect(response.body.errors.map((item: { code: string }) => item.code)).toEqual(['FG_WAREHOUSE_UNMAPPED', 'FG_WAREHOUSE_UNMAPPED']);
    });

    it('SL_CD 가 없으면 외부·불량 창고의 위치는 400 LOCATION_INVALID, 같은 공장의 일반 창고 위치는 받는다', async () => {
      const orderId = await makeOrder(null);
      const proposal = await proposalOf(orderId);

      const external = await confirm(orderId, bodyOf(proposal, { defaultFgLocationId: Number(wh.G.whole) })).expect(400);
      expect(external.body.errors[0]).toMatchObject({ field: 'plans[0].workOrders[0].defaultFgLocationId', code: 'LOCATION_INVALID' });
      await confirm(orderId, bodyOf(proposal, { defaultFgLocationId: Number(wh.A.whole) })).expect(200);
    });

    it('수량 변화 없이 SL_CD 만 바뀌어도 409 PROPOSAL_CHANGED — 오더 판은 그대로다', async () => {
      const orderId = await makeOrder(`${PREFIX}A`);
      const proposal = await proposalOf(orderId);
      await prisma.production_order.update({ where: { production_order_id: orderId }, data: { erp_storage_location_code: `${PREFIX}B` } });

      const response = await confirm(orderId, bodyOf(proposal)).expect(409);
      expect(response.body).toMatchObject({ code: 'PROPOSAL_CHANGED' });
      expect(response.body.proposalChanges.map((change: { basis: string }) => change.basis)).toContain('productionOrder');
      expect(response.body.currentProposal.erpStorage.warehouse.code).toBe(`${PREFIX}B`);
    });

    it('창고가 꺼지면 409 PROPOSAL_CHANGED(resources) 이고 다시 조회하면 비활성 사유다', async () => {
      const orderId = await makeOrder(`${PREFIX}H`);
      const proposal = await proposalOf(orderId);
      expect(proposal.status).toBe('CONFIRMABLE');
      await prisma.warehouse.update({ where: { warehouse_id: wh.H.id }, data: { is_active: false } });
      try {
        const response = await confirm(orderId, bodyOf(proposal)).expect(409);
        expect(response.body.proposalChanges.map((change: { basis: string }) => change.basis)).toEqual(['resources']);
        expect((await proposalOf(orderId)).erpStorage.reasonCode).toBe('FG_WAREHOUSE_INACTIVE');
      } finally {
        await prisma.warehouse.update({ where: { warehouse_id: wh.H.id }, data: { is_active: true } });
      }
    });
  });

  describe('직접 계획 확정(:confirm)과 자동 계획', () => {
    async function draftPlan(orderId: bigint): Promise<{ planId: bigint; version: string }> {
      const plan = await prisma.production_plan.create({ data: {
        production_order_id: orderId, plan_no: `${PREFIX}-PP-${orderId}`, plan_date: new Date(`${planStart}T00:00:00.000Z`), planned_qty: 100,
        uom_id: id.uom, bom_id: id.bom, routing_id: id.routing, status_code: 'DRAFT', planned_line_id: id.line,
      } });
      const etag = (await request(app.getHttpServer()).get(`/api/planning/production-plans/${plan.production_plan_id}`).set('Cookie', cookie).expect(200)).headers.etag as string;
      return { planId: plan.production_plan_id, version: etag };
    }
    const directConfirm = (planId: bigint, version: string) =>
      request(app.getHttpServer()).post(`/api/planning/production-plans/${planId}:confirm`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', version);

    it('SL_CD 창고의 입고 위치가 모든 공정 W/O 에 들어간다 — 계획 라인의 기본 완제품 위치가 아니다', async () => {
      const orderId = await makeOrder(`${PREFIX}A`);
      const { planId, version } = await draftPlan(orderId);
      await directConfirm(planId, version).expect(200);

      expect(await fgOfWorkOrders(orderId)).toEqual([wh.A.whole, wh.A.whole]);
    });

    it('나뉜 창고는 적치 대기', async () => {
      const orderId = await makeOrder(`${PREFIX}B`);
      const { planId, version } = await draftPlan(orderId);
      await directConfirm(planId, version).expect(200);

      expect(await fgOfWorkOrders(orderId)).toEqual([wh.B.staging, wh.B.staging]);
    });

    it('SL_CD 가 없으면 라인 기본 완제품 위치', async () => {
      const orderId = await makeOrder(null);
      const { planId, version } = await draftPlan(orderId);
      await directConfirm(planId, version).expect(200);

      expect(await fgOfWorkOrders(orderId)).toEqual([id.locFg, id.locFg]);
    });

    it('연결 실패는 400 이고 라인 기본값으로 W/O 를 만들지 않는다 — 계획은 작성중으로 남는다', async () => {
      const orderId = await makeOrder(`${PREFIX}D`);
      const { planId, version } = await draftPlan(orderId);

      const response = await directConfirm(planId, version).expect(400);
      expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'erpStorageLocationCode', code: 'FG_WAREHOUSE_OTHER_PLANT' });
      expect(await fgOfWorkOrders(orderId)).toEqual([]);
      expect((await prisma.production_plan.findUniqueOrThrow({ where: { production_plan_id: planId } })).status_code).toBe('DRAFT');
    });

    it('자동 계획(:auto-plan)도 같은 판정을 쓴다', async () => {
      const orderId = await makeOrder(`${PREFIX}B`, id.itemAuto);
      const response = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${orderId}:auto-plan`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).expect(200);

      expect(response.body.outcome).toBe('CONFIRMED');
      expect(await fgOfWorkOrders(orderId)).toEqual([wh.B.staging]);
    });
  });

  describe('MES W/O 수정(PUT)', () => {
    const put = async (workOrderId: bigint, body: object, status: number) => {
      const etag = (await request(app.getHttpServer()).get(`/api/production/work-orders/${workOrderId}`).set('Cookie', cookie).expect(200)).headers.etag as string;
      return request(app.getHttpServer()).put(`/api/production/work-orders/${workOrderId}`).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', etag).send(body).expect(status);
    };
    let orderId: bigint;
    let workOrderId: bigint;

    beforeAll(async () => {
      orderId = await makeOrder(`${PREFIX}B`);
      await confirm(orderId, bodyOf(await proposalOf(orderId))).expect(200);
      workOrderId = (await prisma.work_order.findFirstOrThrow({ where: { production_plan: { production_order_id: orderId } }, orderBy: { work_order_id: 'asc' } })).work_order_id;
    });

    it('다른 창고의 완제품 위치는 400 FG_LOCATION_OUTSIDE_WAREHOUSE', async () => {
      const response = await put(workOrderId, { defaultFgLocationId: Number(id.locFg) }, 400);

      expect(response.body.errors[0]).toMatchObject({ scope: 'field', field: 'defaultFgLocationId', code: 'FG_LOCATION_OUTSIDE_WAREHOUSE' });
      expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).default_fg_location_id).toBe(wh.B.staging);
    });

    it('같은 창고 안의 위치는 받는다', async () => {
      await put(workOrderId, { defaultFgLocationId: Number(wh.B.zone) }, 200);

      expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).default_fg_location_id).toBe(wh.B.zone);
    });

    it('WIP·스크랩은 입고 창고와 무관하지만 자재창고·다른 공장 위치는 400 LOCATION_INVALID', async () => {
      await put(workOrderId, { defaultWipLocationId: Number(id.locFg) }, 200);
      const response = await put(workOrderId, { defaultScrapLocationId: Number(id.locMaterial) }, 400);

      expect(response.body.errors[0]).toMatchObject({ field: 'defaultScrapLocationId', code: 'LOCATION_INVALID' });
    });

    it('라인을 바꿔도 완제품 위치는 라인 기본값으로 덮어써지지 않는다', async () => {
      await put(workOrderId, { productionLineId: Number(id.line2) }, 200);

      expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).default_fg_location_id).toBe(wh.B.zone);
    });

    it('SL_CD 가 나중에 바뀌어도 확정된 W/O 의 위치는 바뀌지 않고, 값을 바꾸지 않는 수정은 막히지 않는다', async () => {
      await prisma.production_order.update({ where: { production_order_id: orderId }, data: { erp_storage_location_code: `${PREFIX}Z` } });

      await put(workOrderId, { priorityNo: 7, defaultFgLocationId: Number(wh.B.zone) }, 200);
      expect(await fgOfWorkOrders(orderId)).toEqual([wh.B.zone, wh.B.staging]);
      // 연결이 끊긴 오더는 새 완제품 위치를 받지 않는다.
      const response = await put(workOrderId, { defaultFgLocationId: Number(wh.B.staging) }, 400);
      expect(response.body.errors[0]).toMatchObject({ field: 'defaultFgLocationId', code: 'FG_WAREHOUSE_UNMAPPED' });
    });
  });

  describe('ERP W/O 조회', () => {
    const show = (orderId: bigint) => request(app.getHttpServer()).get(`/api/planning/production-orders/${orderId}`).set('Cookie', cookie).expect(200);

    it('SL_CD 와 결정된 입고 창고를 내린다 — 연결하지 못한 오더·SL_CD 없는 오더는 창고 키가 없다', async () => {
      const linked = await show(await makeOrder(`${PREFIX}B`));
      expect(validator(response200('/planning/production-orders/{productionOrderId}', 'get'))(linked.body)).toBe(true);
      expect(linked.body).toMatchObject({ erpStorageLocationCode: `${PREFIX}B`, erpStorageWarehouse: { id: Number(wh.B.id), code: `${PREFIX}B`, name: `${PREFIX} 완제품 B` } });

      const broken = await show(await makeOrder(`${PREFIX}Z`));
      expect(broken.body.erpStorageLocationCode).toBe(`${PREFIX}Z`);
      expect(broken.body).not.toHaveProperty('erpStorageWarehouse');
      expect((await show(await makeOrder(null))).body).not.toHaveProperty('erpStorageWarehouse');
    });
  });

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    await prisma.role_permission.createMany({ data: ['W-02-01', 'W-02-02', 'W-02-03'].map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;

    const entity = await prisma.legal_entity.create({ data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: TIMEZONE } });
    const unit = await prisma.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX } });
    id.unit = unit.business_unit_id;
    const plant = (code: string) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: TIMEZONE,
    } });
    id.plant = (await plant('P1')).plant_id;
    const otherPlant = (await plant('P2')).plant_id;
    await prisma.user_data_scope.create({ data: { app_user_id: user.app_user_id, plant_id: id.plant } });
    id.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;

    // 창고마다 「창고 전체」·「적치 대기」는 트리거가 만든다.
    const warehouse = async (suffix: string, over: { plantId?: bigint; type?: string; active?: boolean; defect?: boolean; external?: boolean } = {}) => {
      const row = await prisma.warehouse.create({ data: {
        plant_id: over.plantId ?? id.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}${suffix}`, warehouse_name: `${PREFIX} 완제품 ${suffix}`,
        warehouse_type_code: over.type ?? 'GENERAL', management_level_code: 'LOCATION', is_active: over.active ?? true, is_defect: over.defect ?? false, is_external: over.external ?? false,
      } });
      const system = await prisma.location.findMany({ where: { warehouse_id: row.warehouse_id, system_role_code: { not: null } } });
      const roleOf = (code: string) => system.find((location) => location.system_role_code === code)?.location_id as bigint;
      return { id: row.warehouse_id, whole: roleOf('WAREHOUSE_WHOLE'), staging: roleOf('PUTAWAY_STAGING'), zone: 0n };
    };
    wh.A = await warehouse('A');
    wh.B = await warehouse('B');
    // 나뉜 창고 — 사람이 만든 활성 위치가 하나라도 있다.
    wh.B.zone = (await prisma.location.create({ data: { warehouse_id: wh.B.id, location_code: `${PREFIX}-B1`, location_name: PREFIX, location_type_code: 'BIN' } })).location_id;
    wh.C = await warehouse('C', { active: false });
    wh.D = await warehouse('D', { plantId: otherPlant });
    wh.E = await warehouse('E', { type: 'MATERIAL' });
    wh.F = await warehouse('F', { defect: true });
    wh.G = await warehouse('G', { external: true });
    wh.H = await warehouse('H');
    const lineWarehouse = await warehouse('L');
    const material = await warehouse('M', { type: 'MATERIAL' });
    id.locWip = (await prisma.location.create({ data: { warehouse_id: lineWarehouse.id, location_code: `${PREFIX}-LW`, location_name: PREFIX, location_type_code: 'BIN' } })).location_id;
    id.locFg = (await prisma.location.create({ data: { warehouse_id: lineWarehouse.id, location_code: `${PREFIX}-LF`, location_name: PREFIX, location_type_code: 'BIN' } })).location_id;
    id.locScrap = (await prisma.location.create({ data: { warehouse_id: lineWarehouse.id, location_code: `${PREFIX}-LS`, location_name: PREFIX, location_type_code: 'BIN' } })).location_id;
    id.locMaterial = material.whole;
    id.line = (await prisma.production_line.create({ data: {
      plant_id: id.plant, line_code: `${PREFIX}-LN`, line_name: PREFIX, default_wip_location_id: id.locWip, default_fg_location_id: id.locFg, default_scrap_location_id: id.locScrap,
    } })).production_line_id;
    id.line2 = (await prisma.production_line.create({ data: {
      plant_id: id.plant, line_code: `${PREFIX}-L2`, line_name: PREFIX, default_wip_location_id: id.locWip, default_fg_location_id: id.locFg, default_scrap_location_id: id.locScrap,
    } })).production_line_id;
    // 기본 완제품 위치가 없는 라인.
    id.lineBare = (await prisma.production_line.create({ data: {
      plant_id: id.plant, line_code: `${PREFIX}-LB`, line_name: PREFIX, default_wip_location_id: id.locWip, default_scrap_location_id: id.locScrap,
    } })).production_line_id;
    const equipment = async (code: string, lineId: bigint) => (await prisma.equipment.create({ data: {
      plant_id: id.plant, equipment_code: `${PREFIX}-${code}`, equipment_name: PREFIX, equipment_type_code: 'PRESS', status_code: 'IN_SERVICE', production_line_id: lineId,
    } })).equipment_id;
    const equipmentLine = await equipment('EQ1', id.line);
    const equipmentBare = await equipment('EQ2', id.lineBare);
    // 기본 매핑이 공정마다 설비를 따로 정해야 공정 W/O 마다 라인이 선다.
    const processes = await Promise.all([1, 2].map((n) => prisma.process.create({ data: { process_code: `${PREFIX}-PR${n}`, process_name: `공정${n}`, process_type_code: 'PRODUCTION' } })));

    const item = async (code: string, operations: number, equipmentId: bigint) => {
      const itemId = (await prisma.item.create({ data: { item_code: `${PREFIX}-${code}`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: id.uom } })).item_id;
      const bomId = (await prisma.bom.create({ data: {
        parent_item_id: itemId, bom_code: `${PREFIX}-BOM-${code}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: id.uom,
      } })).bom_id;
      const routing = await prisma.routing.create({ data: { item_id: itemId, routing_code: `${PREFIX}-RT-${code}`, routing_version: 1, status_code: 'CONFIRMED' } });
      for (let index = 0; index < operations; index += 1) {
        await prisma.routing_operation.create({ data: {
          routing_id: routing.routing_id, operation_seq: (index + 1) * 10, process_id: processes[index].process_id, operation_name: `공정${(index + 1) * 10}`, equipment_required: true, mold_required: false,
        } });
        await prisma.item_resource_map.create({ data: { plant_id: id.plant, item_id: itemId, process_id: processes[index].process_id, equipment_id: equipmentId, is_default: true } });
      }
      return { itemId, bomId, routingId: routing.routing_id };
    };
    const main = await item('IT', 2, equipmentLine);
    [id.item, id.bom, id.routing] = [main.itemId, main.bomId, main.routingId];
    id.itemNoDefault = (await item('IT-NF', 1, equipmentBare)).itemId;
    id.itemAuto = (await item('IT-AU', 1, equipmentLine)).itemId;
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const scope = { production_order: { production_order_no: { startsWith: PREFIX } } };
    const plans = await prisma.production_plan.findMany({ where: scope, select: { production_plan_id: true } });
    const workOrders = await prisma.work_order.findMany({ where: { production_plan_id: { in: plans.map((row) => row.production_plan_id) } }, select: { work_order_id: true } });
    const workOrderIds = workOrders.map((row) => row.work_order_id);
    await prisma.work_order_dependency.deleteMany({ where: { OR: [{ predecessor_work_order_id: { in: workOrderIds } }, { successor_work_order_id: { in: workOrderIds } }] } });
    await prisma.work_order.deleteMany({ where: { work_order_id: { in: workOrderIds } } });
    await prisma.production_plan.deleteMany({ where: scope });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.item_resource_map.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    const userIds = users.map((row) => row.app_user_id);
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: `${PREFIX}-` } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: `${PREFIX}-` } } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }
});

function shiftDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
