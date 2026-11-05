/**
 * ERP W/O 계획 제안 조회 · 선택 확정 (e2e).
 *
 * 조회는 부작용이 없다(계획·W/O·번호·멱등 기록·오더 판 그대로). 확정은 고른 ERP W/O 하나를 한 트랜잭션으로 저장하고,
 * 같은 키 재전송·다른 키 재클릭·검토 뒤 기준 변경·본문 검증을 본다.
 * ⚠ 4M 자동 배정은 이 시험 데이터로 «규칙»만 본다(기본 매핑 → 설비·금형·라인, 라인 → 기본 위치) — 실데이터 검증이 아니다.
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

const PREFIX = 'PPR236';
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const PROPOSALS = '/api/planning/production-orders:plan-proposals';
const confirmPath = (orderId: bigint | number): string => `/api/planning/production-orders/${orderId}:confirm-plan-proposal`;

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

interface Proposal {
  productionOrderId: number;
  kind: string;
  status: string;
  reasons: { code: string; category: string }[];
  remainingQty: number;
  basis: Record<string, string>;
  issues: { code: string }[];
  plans: {
    proposalPlanKey: string;
    planSource: string;
    productionPlanId?: number;
    planDate: string;
    proposedQty: number;
    bomId: number;
    routingId: number;
    plannedLineId: number | null;
    saved?: { versionNo: number };
    workOrders: {
      routingOperationId: number;
      predecessors: { routingOperationId: number }[];
      plannedStartAt: string;
      plannedEndAt: string;
      productionLineId: number | null;
      plannedEquipmentId: number | null;
      plannedMoldId: number | null;
      responsibleWorkerId: number | null;
      plannedShiftId: number | null;
      defaultWipLocationId: number | null;
      defaultFgLocationId: number | null;
      defaultScrapLocationId: number | null;
      issues: { severity: string; code: string; field?: string }[];
    }[];
  }[];
}

describe('ERP W/O 계획 제안 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let strangerCookie: string;
  const id: Record<string, bigint> = {};
  const order: Record<string, bigint> = {};
  const planStart = shiftDays(localToday(), 3);

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

  const propose = (...orderIds: (bigint | number)[]) =>
    request(app.getHttpServer()).get(PROPOSALS).query({ productionOrderIds: orderIds.map(String).join(',') }).set('Cookie', cookie);
  const proposalOf = async (orderId: bigint): Promise<Proposal> => ((await propose(orderId).expect(200)).body as { items: Proposal[] }).items[0];
  const confirm = (orderId: bigint | number, body: unknown, key: string = randomUUID()) =>
    request(app.getHttpServer()).post(confirmPath(orderId)).set('Cookie', cookie).set('Idempotency-Key', key).send(body as object);

  /** 제안을 그대로 확정 본문으로 — 보완 4M 은 제안 값, 빈 칸은 `fill` 로 채운다. */
  function bodyOf(proposal: Proposal, fill: Record<string, number | null> = {}) {
    return {
      basis: proposal.basis,
      plans: proposal.plans.map((plan) => ({
        proposalPlanKey: plan.proposalPlanKey,
        planDate: plan.planDate,
        plannedQty: plan.proposedQty,
        bomId: plan.bomId,
        routingId: plan.routingId,
        plannedLineId: plan.plannedLineId,
        workOrders: plan.workOrders.map((workOrder) => ({
          routingOperationId: workOrder.routingOperationId,
          productionLineId: workOrder.productionLineId ?? fill.productionLineId,
          plannedEquipmentId: workOrder.plannedEquipmentId,
          plannedMoldId: workOrder.plannedMoldId,
          defaultWipLocationId: workOrder.defaultWipLocationId ?? fill.defaultWipLocationId,
          defaultFgLocationId: workOrder.defaultFgLocationId ?? fill.defaultFgLocationId,
          defaultScrapLocationId: workOrder.defaultScrapLocationId ?? fill.defaultScrapLocationId,
        })),
      })),
    };
  }

  describe('제안 조회', () => {
    it('ERP W/O 마다 제안을 입력 순서로 내고, 범위 밖·없는 id 는 notFound 에 담는다 — 계약 응답과 맞는다', async () => {
      const response = await propose(order.A, order.B, order.OUT, order.C, 999999999, order.A).expect(200);

      expect((response.body.items as Proposal[]).map((item) => item.productionOrderId)).toEqual([order.A, order.B, order.C].map(Number));
      expect(response.body.notFoundProductionOrderIds).toEqual([Number(order.OUT), 999999999]);
      expect(validator(response200('/planning/production-orders:plan-proposals', 'get'))(response.body)).toBe(true);
    });

    it('신규 제안은 잔량으로 새 계획 하나 — ERP 기본 BOM·Routing, 공정 순서·선행, 근무일 하루, 기본 매핑으로 4M 을 채운다(규칙 검증)', async () => {
      const proposal = await proposalOf(order.A);

      expect(proposal).toMatchObject({ kind: 'NEW_PLAN', status: 'CONFIRMABLE', reasons: [], remainingQty: 100, issues: [] });
      expect(proposal.plans).toHaveLength(1);
      const [plan] = proposal.plans;
      expect(plan).toMatchObject({
        proposalPlanKey: 'new-1', planSource: 'NEW', planDate: planStart, proposedQty: 100,
        bomId: Number(id.bomOk), routingId: Number(id.routingOk), plannedLineId: null,
      });
      expect(plan).not.toHaveProperty('productionPlanId');
      const [first, second] = plan.workOrders;
      // 근무일 하루 — 가장 이른 활성 교대(07:00, 공장 시각)부터 24시간.
      expect([first.plannedStartAt, first.plannedEndAt]).toEqual([`${planStart}T00:00:00.000Z`, `${shiftDays(planStart, 1)}T00:00:00.000Z`]);
      expect(first).toMatchObject({
        routingOperationId: Number(id.op10), predecessors: [],
        plannedEquipmentId: Number(id.eq1), plannedMoldId: Number(id.mold), productionLineId: Number(id.line),
        defaultWipLocationId: Number(id.loc1), defaultFgLocationId: Number(id.loc2), defaultScrapLocationId: Number(id.loc3),
        responsibleWorkerId: null, plannedShiftId: null, issues: [],
      });
      // 공정을 지정한 매핑은 그 공정에 — 금형은 첫 필요 공정에만 간다.
      expect(second).toMatchObject({
        routingOperationId: Number(id.op20), predecessors: [{ routingOperationId: Number(id.op10) }],
        plannedEquipmentId: Number(id.eq2), plannedMoldId: null, productionLineId: Number(id.line),
      });
    });

    it('구분·상태·사유 — 제안 불가(기준정보)는 BLOCKED, 라인 미지정은 INPUT, 확정 유지·취소는 변경 없음', async () => {
      const response = await propose(order.B, order.C, order.D, order.F, order.G).expect(200);
      const summary = (response.body.items as Proposal[]).map((item) => [item.kind, item.status, item.reasons, item.plans.length]);

      expect(summary).toEqual([
        ['NOT_PROPOSABLE', 'NEEDS_INPUT', [{ code: 'BOM_DEFAULT_REQUIRED', category: 'BLOCKED' }], 0],
        ['NOT_PROPOSABLE', 'NEEDS_INPUT', [{ code: 'ROUTING_REQUIRED', category: 'BLOCKED' }], 0],
        ['NEW_PLAN', 'NEEDS_INPUT', [{ code: 'WORK_ORDER_LINE_REQUIRED', category: 'INPUT' }], 1],
        ['KEEP_CONFIRMED', 'NO_CHANGE', [], 0],
        ['NOT_PROPOSABLE', 'NO_CHANGE', [{ code: 'ORDER_CANCELLED', category: 'BLOCKED' }], 0],
      ]);
      const lineless = (response.body.items as Proposal[])[2].plans[0].workOrders[0];
      expect(lineless.issues).toEqual([expect.objectContaining({ severity: 'BLOCK', code: 'WORK_ORDER_LINE_REQUIRED', field: 'productionLineId' })]);
    });

    it('작성중 계획이 있으면 그 계획을 검토한다 — 임시 키는 저장된 id 로, 저장값을 함께 싣고 남은 수량은 제안하지 않는다', async () => {
      const proposal = await proposalOf(order.E);

      expect(proposal).toMatchObject({ kind: 'REVIEW_DRAFT', status: 'CONFIRMABLE', remainingQty: 40 });
      expect(proposal.plans).toEqual([expect.objectContaining({
        proposalPlanKey: `plan-${id.draftE}`, planSource: 'EXISTING_DRAFT', productionPlanId: Number(id.draftE), proposedQty: 60, saved: expect.objectContaining({ versionNo: 1 }),
      })]);
    });

    it('부작용이 없다 — 계획·W/O·번호·멱등 기록·ERP W/O 판과 시도 기록이 그대로다', async () => {
      const before = await snapshot();
      await propose(order.A, order.B, order.C, order.D, order.E, order.F, order.G).expect(200);
      expect(await snapshot()).toEqual(before);
    });

    it('권한이 없으면 403', async () => {
      await request(app.getHttpServer()).get(PROPOSALS).query({ productionOrderIds: String(order.A) }).set('Cookie', strangerCookie).expect(403);
    });
  });

  describe('선택 확정', () => {
    let firstResponse: Record<string, unknown>;
    let firstBody: unknown;
    let firstKey = '';

    it('제안과 보완 4M 으로 계획을 확정하고 공정별 W/O·의존을 만든다 — 교대를 고르면 그 교대 시각(자정 넘기면 다음 날)', async () => {
      const proposal = await proposalOf(order.A);
      const body = bodyOf(proposal);
      Object.assign(body.plans[0].workOrders[0], { plannedShiftId: Number(id.nightShift), responsibleWorkerId: Number(id.worker) });
      firstKey = randomUUID();
      firstBody = body;

      const response = await confirm(order.A, body, firstKey).expect(200);
      firstResponse = response.body as Record<string, unknown>;

      expect(validator(response200('/planning/production-orders/{productionOrderId}:confirm-plan-proposal', 'post'))(response.body)).toBe(true);
      expect(response.body).toMatchObject({ productionOrderId: Number(order.A), outcome: 'CONFIRMED' });
      const [planResult] = response.body.plans as { proposalPlanKey: string; productionPlanId: number; statusCode: string; workOrders: { workOrderId: number; routingOperationId: number }[] }[];
      expect(planResult).toMatchObject({ proposalPlanKey: 'new-1', statusCode: 'CONFIRMED' });

      const plan = await prisma.production_plan.findUniqueOrThrow({ where: { production_plan_id: BigInt(planResult.productionPlanId) } });
      expect(plan).toMatchObject({ status_code: 'CONFIRMED', bom_id: id.bomOk, routing_id: id.routingOk });
      expect(Number(plan.planned_qty)).toBe(100);
      const workOrders = await prisma.work_order.findMany({ where: { production_plan_id: plan.production_plan_id }, orderBy: { routing_operation: { operation_seq: 'asc' } } });
      expect(workOrders.map((row) => Number(row.work_order_id))).toEqual(planResult.workOrders.map((row) => row.workOrderId));
      expect(workOrders[0]).toMatchObject({
        production_line_id: id.line, planned_equipment_id: id.eq1, planned_mold_id: id.mold, responsible_worker_id: id.worker, planned_shift_id: id.nightShift,
        default_wip_location_id: id.loc1, default_fg_location_id: id.loc2, default_scrap_location_id: id.loc3,
      });
      // 야간 19:00~07:00(공장 시각 +07:00).
      expect([workOrders[0].planned_start_at?.toISOString(), workOrders[0].planned_end_at?.toISOString()])
        .toEqual([`${planStart}T12:00:00.000Z`, `${shiftDays(planStart, 1)}T00:00:00.000Z`]);
      expect(workOrders[1]).toMatchObject({ planned_equipment_id: id.eq2, planned_shift_id: null, responsible_worker_id: null });
      expect(workOrders[1].planned_start_at?.toISOString()).toBe(`${planStart}T00:00:00.000Z`);
      expect(await prisma.work_order_dependency.count({ where: { successor_work_order_id: workOrders[1].work_order_id } })).toBe(1);
    });

    it('같은 키 재전송은 처음 응답 그대로이고 아무것도 더 만들지 않는다', async () => {
      const before = await snapshot();
      const again = await confirm(order.A, firstBody, firstKey).expect(200);
      expect(again.body).toEqual(firstResponse);
      expect(await snapshot()).toEqual(before);
    });

    it('다른 키로 다시 누르면 저장하지 않고 ALREADY_PROCESSED 와 기존 결과다', async () => {
      const { plans, workOrders, counters } = await snapshot();
      const again = await confirm(order.A, firstBody).expect(200);

      expect(again.body).toEqual({ ...firstResponse, outcome: 'ALREADY_PROCESSED', plans: (firstResponse.plans as Record<string, unknown>[]).map(({ proposalPlanKey: _, ...plan }) => plan) });
      expect(await snapshot()).toMatchObject({ plans, workOrders, counters });
    });

    it('검토한 뒤 ERP W/O 수량이 바뀌면 409 PROPOSAL_CHANGED 와 지금 제안이고 저장하지 않는다', async () => {
      const body = bodyOf(await proposalOf(order.H));
      await prisma.production_order.update({ where: { production_order_id: order.H }, data: { order_qty: 80, version_no: { increment: 1 } } });

      const response = await confirm(order.H, body).expect(409);
      expect(response.body).toMatchObject({ code: 'PROPOSAL_CHANGED', proposalChanges: [{ basis: 'productionOrder', message: expect.stringContaining('80') }] });
      expect(response.body.currentProposal).toMatchObject({ productionOrderId: Number(order.H), remainingQty: 80 });
      expect(validator('/components/schemas/ProductionConflictResponse')(response.body)).toBe(true);
      expect(await prisma.production_plan.count({ where: { production_order_id: order.H } })).toBe(0);
    });

    it('검토한 뒤 작성중 계획이 고쳐지면 409(plans) — 다시 조회해 확정하면 그 작성중 계획이 확정된다', async () => {
      const stale = bodyOf(await proposalOf(order.E));
      await request(app.getHttpServer())
        .put(`/api/planning/production-plans/${id.draftE}`)
        .set('Cookie', cookie).set('Idempotency-Key', randomUUID()).set('If-Match', '1')
        .send({ plannedQty: 50 })
        .expect(200);

      const changed = await confirm(order.E, stale).expect(409);
      expect(changed.body.proposalChanges.map((change: { basis: string }) => change.basis)).toEqual(['plans']);

      const fresh = await confirm(order.E, bodyOf(await proposalOf(order.E))).expect(200);
      expect(fresh.body.plans).toEqual([expect.objectContaining({ proposalPlanKey: `plan-${id.draftE}`, productionPlanId: Number(id.draftE), statusCode: 'CONFIRMED' })]);
      expect(await prisma.production_plan.count({ where: { production_order_id: order.E } })).toBe(1);
    });

    it('본문은 수기 등록·확정과 같은 규칙으로 검증한다 — 오류를 모아 본문 경로로 내고, 저장하지 않고 번호도 쓰지 않는다', async () => {
      const proposal = await proposalOf(order.J);
      const body = bodyOf(proposal);
      body.plans[0].bomId = Number(id.bomOld);
      Object.assign(body.plans[0].workOrders[0], { productionLineId: Number(id.foreignLine), defaultWipLocationId: Number(id.materialLoc), plannedEquipmentId: Number(id.eqDown) });
      const before = await snapshot();

      const response = await confirm(order.J, body).expect(400);
      expect(response.body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'plans[0].bomId', code: 'BOM_NOT_DEFAULT' }),
        expect.objectContaining({ field: 'plans[0].workOrders[0].productionLineId', code: 'LINE_PLANT_MISMATCH' }),
        expect.objectContaining({ field: 'plans[0].workOrders[0].defaultWipLocationId', code: 'INVALID' }),
        expect.objectContaining({ field: 'plans[0].workOrders[0].plannedEquipmentId', code: 'EQUIPMENT_NOT_IN_SERVICE' }),
      ]));
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['공정이 빠지면 plans[0].workOrders', (body: ReturnType<typeof bodyOf>) => { body.plans[0].workOrders.pop(); }, 'plans[0].workOrders', 'INVALID'],
      ['계획 집합이 제안과 다르면 plans', (body: ReturnType<typeof bodyOf>) => { body.plans[0].proposalPlanKey = 'new-2'; }, 'plans', 'INVALID'],
      ['수량이 ERP W/O 를 넘으면 plans[0].plannedQty', (body: ReturnType<typeof bodyOf>) => { body.plans[0].plannedQty = 101; }, 'plans[0].plannedQty', 'PLAN_QTY_EXCEEDS_ORDER'],
      ['필수 4M 이 없으면 계약 검사가 막는다', (body: ReturnType<typeof bodyOf>) => { delete (body.plans[0].workOrders[0] as { productionLineId?: number }).productionLineId; }, 'plans[0].workOrders[0].productionLineId', 'REQUIRED'],
    ])('%s 400', async (_, mutate, field, code) => {
      const body = bodyOf(await proposalOf(order.J));
      mutate(body);
      const response = await confirm(order.J, body).expect(400);
      expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field, code })]));
      expect(await prisma.production_plan.count({ where: { production_order_id: order.J } })).toBe(0);
    });

    it('보완 필요(라인 미지정)는 확정 본문에 라인·기본 위치를 채우면 확정된다', async () => {
      const fill = { productionLineId: Number(id.line), defaultWipLocationId: Number(id.loc1), defaultFgLocationId: Number(id.loc2), defaultScrapLocationId: Number(id.loc3) };
      const response = await confirm(order.D, bodyOf(await proposalOf(order.D), fill)).expect(200);

      expect(response.body).toMatchObject({ outcome: 'CONFIRMED' });
      const [workOrder] = await prisma.work_order.findMany({ where: { production_plan: { production_order_id: order.D } } });
      expect(workOrder).toMatchObject({ production_line_id: id.line, default_wip_location_id: id.loc1, planned_equipment_id: null });
    });

    it('다른 키로 동시에 두 번 눌러도 계획은 하나다 — 늦은 쪽은 ALREADY_PROCESSED', async () => {
      const body = bodyOf(await proposalOf(order.H));
      const responses = await Promise.all([confirm(order.H, body), confirm(order.H, body)]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses.map((response) => response.body.outcome as string).sort()).toEqual(['ALREADY_PROCESSED', 'CONFIRMED']);
      expect(await prisma.production_plan.count({ where: { production_order_id: order.H } })).toBe(1);
    });

    it('취소된 ERP W/O 는 400 STATE_LOCKED, 범위 밖·없는 ERP W/O 는 404', async () => {
      const response = await confirm(order.G, bodyOf(await proposalOf(order.J))).expect(400);
      expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
      await confirm(order.OUT, bodyOf(await proposalOf(order.J))).expect(404);
      await confirm(999999999, bodyOf(await proposalOf(order.J))).expect(404);
    });
  });

  /** 쓰기 흔적 — 제안 조회·거부된 확정 앞뒤로 견준다. 번호 카운터는 전역이다(다른 검사가 동시에 돌지 않는 일꾼 DB 안). */
  async function snapshot() {
    const orders = Object.values(order);
    const [plans, workOrders, counters, idempotency, orderRows] = await Promise.all([
      prisma.production_plan.findMany({ where: { production_order_id: { in: orders } }, select: { production_plan_id: true, version_no: true, status_code: true }, orderBy: { production_plan_id: 'asc' } }),
      prisma.work_order.count({ where: { production_plan: { production_order_id: { in: orders } } } }),
      prisma.numbering_counter.findMany({ select: { numbering_counter_id: true, last_value: true }, orderBy: { numbering_counter_id: 'asc' } }),
      prisma.idempotency_record.count(),
      prisma.production_order.findMany({ where: { production_order_id: { in: orders } }, select: { version_no: true, auto_plan_attempted_at: true }, orderBy: { production_order_id: 'asc' } }),
    ]);
    return { plans, workOrders, counters, idempotency, orderRows };
  }

  async function fixtures(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } });
    await prisma.role_permission.createMany({ data: ['W-02-01', 'W-02-02'].map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const stranger = await prisma.app_user.create({ data: { login_id: `${PREFIX}-STRANGER`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const strangerRole = await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE-NONE`, role_name: PREFIX } });
    await prisma.user_role.create({ data: { app_user_id: stranger.app_user_id, role_id: strangerRole.role_id } });
    const sign = (userId: bigint): string => `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(userId), typ: 'session' })}`;
    cookie = sign(user.app_user_id);
    strangerCookie = sign(stranger.app_user_id);

    const entity = await prisma.legal_entity.create({ data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: TIMEZONE } });
    const unit = await prisma.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: PREFIX } });
    const plant = (code: string) => prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PREFIX}-${code}`, plant_name: PREFIX, timezone_code: TIMEZONE,
    } });
    id.plant = (await plant('P1')).plant_id;
    id.otherPlant = (await plant('P2')).plant_id;
    await prisma.user_data_scope.create({ data: { app_user_id: user.app_user_id, plant_id: id.plant } });
    const time = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);
    await prisma.shift.create({ data: { plant_id: id.plant, shift_code: `${PREFIX}-D`, shift_name: '주간', start_time: time('07:00'), end_time: time('19:00') } });
    id.nightShift = (await prisma.shift.create({ data: {
      plant_id: id.plant, shift_code: `${PREFIX}-N`, shift_name: '야간', start_time: time('19:00'), end_time: time('07:00'), crosses_midnight: true,
    } })).shift_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } });
    id.uom = uom.uom_id;

    const warehouse = async (code: string, type: string) => prisma.warehouse.create({ data: {
      plant_id: id.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-${code}`, warehouse_name: PREFIX, warehouse_type_code: type, management_level_code: 'LOCATION',
    } });
    const general = await warehouse('WH', 'GENERAL');
    const material = await warehouse('WHM', 'MATERIAL');
    const location = async (warehouseId: bigint, code: string) => (await prisma.location.create({ data: {
      warehouse_id: warehouseId, location_code: `${PREFIX}-${code}`, location_name: PREFIX, location_type_code: 'BIN',
    } })).location_id;
    id.loc1 = await location(general.warehouse_id, 'L1');
    id.loc2 = await location(general.warehouse_id, 'L2');
    id.loc3 = await location(general.warehouse_id, 'L3');
    id.materialLoc = await location(material.warehouse_id, 'LM');
    id.line = (await prisma.production_line.create({ data: {
      plant_id: id.plant, line_code: `${PREFIX}-LN`, line_name: PREFIX,
      default_wip_location_id: id.loc1, default_fg_location_id: id.loc2, default_scrap_location_id: id.loc3,
    } })).production_line_id;
    id.foreignLine = (await prisma.production_line.create({ data: { plant_id: id.otherPlant, line_code: `${PREFIX}-LNF`, line_name: PREFIX } })).production_line_id;
    const equipment = async (code: string, status: string) => (await prisma.equipment.create({ data: {
      plant_id: id.plant, equipment_code: `${PREFIX}-${code}`, equipment_name: PREFIX, equipment_type_code: 'PRESS', status_code: status, production_line_id: id.line,
    } })).equipment_id;
    id.eq1 = await equipment('EQ1', 'IN_SERVICE');
    id.eq2 = await equipment('EQ2', 'IN_SERVICE');
    id.eqDown = await equipment('EQX', 'DISPOSED');
    id.mold = (await prisma.mold.create({ data: { plant_id: id.plant, mold_code: `${PREFIX}-MOLD`, mold_name: PREFIX, status_code: 'IN_SERVICE', tool_type_code: 'MOLD' } })).mold_id;
    id.worker = (await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-W1`, worker_name: PREFIX, business_unit_id: unit.business_unit_id, plant_id: id.plant, status_code: 'EMPLOYED',
    } })).worker_id;
    const process10 = await prisma.process.create({ data: { process_code: `${PREFIX}-PR10`, process_name: '사출', process_type_code: 'MOLDING' } });
    const process20 = await prisma.process.create({ data: { process_code: `${PREFIX}-PR20`, process_name: '조립', process_type_code: 'PRODUCTION' } });

    const item = async (code: string) => (await prisma.item.create({ data: { item_code: `${PREFIX}-${code}`, item_name: PREFIX, item_type_code: 'FINISHED_GOOD', base_uom_id: id.uom } })).item_id;
    const bom = async (itemId: bigint, version: number, isDefault: boolean) => (await prisma.bom.create({ data: {
      parent_item_id: itemId, bom_code: `${PREFIX}-BOM-${itemId}`, bom_version: version, status_code: 'CONFIRMED', is_default: isDefault,
      effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: id.uom,
    } })).bom_id;
    const routing = async (itemId: bigint, operations: { process: bigint; equipment: boolean; mold: boolean }[]) => {
      const row = await prisma.routing.create({ data: { item_id: itemId, routing_code: `${PREFIX}-RT-${itemId}`, routing_version: 1, status_code: 'CONFIRMED' } });
      const created = [];
      for (const [index, need] of operations.entries()) {
        created.push(await prisma.routing_operation.create({ data: {
          routing_id: row.routing_id, operation_seq: (index + 1) * 10, process_id: need.process, operation_name: `공정${(index + 1) * 10}`,
          equipment_required: need.equipment, mold_required: need.mold,
        } }));
      }
      return { routingId: row.routing_id, operations: created.map((operation) => operation.routing_operation_id) };
    };

    id.itemOk = await item('IT-OK');
    id.bomOld = await bom(id.itemOk, 1, false);
    id.bomOk = await bom(id.itemOk, 2, true);
    const ok = await routing(id.itemOk, [{ process: process10.process_id, equipment: true, mold: true }, { process: process20.process_id, equipment: true, mold: true }]);
    id.routingOk = ok.routingId;
    [id.op10, id.op20] = ok.operations;
    await prisma.routing_operation_dependency.create({ data: { predecessor_operation_id: id.op10, successor_operation_id: id.op20 } });
    await prisma.item_resource_map.createMany({ data: [
      { plant_id: id.plant, item_id: id.itemOk, equipment_id: id.eq1, mold_id: id.mold, is_default: true },
      { plant_id: id.plant, item_id: id.itemOk, process_id: process20.process_id, equipment_id: id.eq2, is_default: true },
    ] });
    const itemNoBom = await item('IT-NOBOM');
    await routing(itemNoBom, [{ process: process20.process_id, equipment: false, mold: false }]);
    const itemNoRouting = await item('IT-NORT');
    await bom(itemNoRouting, 1, true);
    const itemNoLine = await item('IT-NOLINE');
    await bom(itemNoLine, 1, true);
    await routing(itemNoLine, [{ process: process20.process_id, equipment: false, mold: false }]);

    const makeOrder = async (key: string, itemId: bigint, opts: { plantId?: bigint; status?: string } = {}) => {
      order[key] = (await prisma.production_order.create({ data: {
        production_order_no: `${PREFIX}-${key}`, business_unit_id: unit.business_unit_id, plant_id: opts.plantId ?? id.plant, item_id: itemId,
        order_qty: 100, uom_id: id.uom, status_code: opts.status ?? 'RECEIVED', planned_start_date: new Date(`${planStart}T00:00:00.000Z`),
      } })).production_order_id;
    };
    await makeOrder('A', id.itemOk);
    await makeOrder('B', itemNoBom);
    await makeOrder('C', itemNoRouting);
    await makeOrder('D', itemNoLine);
    await makeOrder('E', id.itemOk);
    await makeOrder('F', id.itemOk);
    await makeOrder('G', id.itemOk, { status: 'CANCELLED' });
    await makeOrder('H', id.itemOk);
    await makeOrder('J', id.itemOk);
    await makeOrder('OUT', id.itemOk, { plantId: id.otherPlant });
    const plan = (orderId: bigint, key: string, qty: number, status: string) => prisma.production_plan.create({ data: {
      production_order_id: orderId, plan_no: `${PREFIX}-PP-${key}`, plan_date: new Date(`${planStart}T00:00:00.000Z`), planned_qty: qty,
      uom_id: id.uom, bom_id: id.bomOk, routing_id: id.routingOk, status_code: status, confirmed_at: status === 'CONFIRMED' ? new Date() : null,
    } });
    id.draftE = (await plan(order.E, 'E', 60, 'DRAFT')).production_plan_id;
    await plan(order.F, 'F', 100, 'CONFIRMED');
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
    await prisma.routing_operation_dependency.deleteMany({ where: { predecessor_operation_id: { in: (await prisma.routing_operation.findMany({ where: { routing: { routing_code: { startsWith: PREFIX } } }, select: { routing_operation_id: true } })).map((row) => row.routing_operation_id) } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.mold.deleteMany({ where: { mold_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
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
