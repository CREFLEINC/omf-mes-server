/**
 * 재작업 W/O 발행 (e2e) — `POST /quality/nonconformances/{id}:issue-rework-work-order`
 * (omf-all-around#47 · 장부 P-33).
 *
 * ⭐ **이 경로가 서야 P-04-03(POP 재작업 실적 등록)이 대상을 찾는다.** 그전에는 재작업 유형 W/O
 *    를 만들 길이 없어 그 화면이 빈 목록이었다.
 *
 * ⭐ **상한은 처분 판정이 정한다** — 재작업 판정 수량 합에서 이미 발행한 W/O 수량을 뺀 잔량이다.
 *    ⛔ 같은 흐름의 일반 생산 실적은 초과를 막지 않고 되묻지만(omf-mes-client#1040), 재작업은
 *    **막는 쪽**이다(사용자 결정 2026-09-21).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'AA47RW';
const LOGIN_ID = 'e2e-aa47-probe';
const PASSWORD = 'PR-재작업발행-비밀번호';
/** ⭐ 발행 주체는 품질 담당이다 — `W-03-10` «만» 가진 계정으로 잰다(권한 매핑이 빠지면 403). */
const PERMISSION = 'W-03-10';
const ROLE = 'E2E_AA47_REWORK';

describe('재작업 W/O 발행 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids: Record<string, bigint> = {};
  /** 부적합 이름 → id. 갈래마다 «자기» 부적합을 쓴다(순서 의존 0). */
  const ncIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser();
    await makeMasters();
    await makeNonconformances();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const issue = (nonconformanceId: number, ifMatch: string | number) =>
    request(app.getHttpServer())
      .post(`/api/quality/nonconformances/${nonconformanceId}:issue-rework-work-order`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(ifMatch));

  const body = (overrides: Record<string, unknown> = {}) => ({
    routingOperationId: Number(ids.operation),
    orderQty: 40,
    ...overrides,
  });

  it('⭐ 201 — REWORK 유형 W/O 가 서고 근거 부적합이 실린다', async () => {
    const response = await issue(ncIds.rework, 1).send(body()).expect(201);

    expect(response.body).toMatchObject({
      workOrderTypeCode: 'REWORK',
      statusCode: 'PLANNED',
      orderQty: 40,
      reworkSourceNonconformanceId: ncIds.rework,
      /* 60 − 40 = 20 — 화면이 중복 발행을 막는 값이다. */
      remainingQty: 20,
    });
    /* ⭐ 판정 저장과 같은 규율 — 발행이 부적합의 판을 올린다. */
    expect(response.headers.etag).toBe('2');

    const row = await prisma.work_order.findUniqueOrThrow({
      where: { work_order_id: BigInt(response.body.workOrderId) },
    });
    expect(row).toMatchObject({
      work_order_type_code: 'REWORK',
      rework_source_nonconformance_id: BigInt(ncIds.rework),
      rework_source_lot_id: ids.lotRework,
      production_plan_id: ids.plan,
    });

    /* ⭐ P-04-03 이 이 축으로 대상을 찾는다 — 그 조회가 실제로 잡는지까지 본다. */
    const listed = await request(app.getHttpServer())
      .get(`/api/production/work-orders?workOrderTypeCode=REWORK&size=50`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      (listed.body.items as { workOrderId: number }[]).some(
        (item) => item.workOrderId === response.body.workOrderId,
      ),
    ).toBe(true);
  });

  /* ⛔ 판정 잔량을 넘는 발행은 막는다 — 되돌릴 지시가 또 필요해진다. */
  it('⛔ 판정 잔량을 넘으면 409 이고 W/O 가 서지 않는다', async () => {
    const before = await prisma.work_order.count({
      where: { rework_source_nonconformance_id: BigInt(ncIds.exceed) },
    });

    const response = await issue(ncIds.exceed, 1).send(body({ orderQty: 31 })).expect(409);

    expect(response.body).toMatchObject({ code: 'DISPOSITION_QTY_EXCEEDED' });
    expect(
      await prisma.work_order.count({ where: { rework_source_nonconformance_id: BigInt(ncIds.exceed) } }),
    ).toBe(before);
  });

  /* ⛔ 재작업 판정이 없으면 발행할 근거가 없다 — 폐기 판정만 있는 부적합이다. */
  it('⛔ 재작업 판정이 없으면 409 다', async () => {
    const response = await issue(ncIds.scrapOnly, 1).send(body({ orderQty: 1 })).expect(409);

    expect(response.body).toMatchObject({ code: 'INVALID_STATE' });
  });

  /* 원천 W/O 가 없는 부적합(입고 검사 등)은 승계할 계획이 없다 — 지어내지 않는다. */
  it('⛔ 원천 작업지시가 없는 부적합은 400 이다', async () => {
    const response = await issue(ncIds.noWorkOrder, 1).send(body({ orderQty: 1 })).expect(400);

    expect(response.body.errors[0]).toMatchObject({ field: 'nonconformanceId' });
  });

  /* ⛔ 낡은 토큰은 막는다 — 그사이 다른 사람이 잔량을 썼을 수 있다. */
  it('⛔ If-Match 가 낡으면 409 VERSION_CONFLICT 다', async () => {
    const response = await issue(ncIds.stale, 99).send(body({ orderQty: 1 })).expect(409);

    expect(response.body).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  // ─────────────────────────────── 픽스처 ───────────────────────────────

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '재작업발행자', status_code: 'EMPLOYED' },
    });
    ids.user = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '재작업발행용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: PERMISSION },
    });
    /* 발행된 W/O 를 조회로 되읽는 시험이 있어 생산 조회 권한도 준다. */
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-04' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '재작업법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '재작업사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '재작업공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '재작업품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '재작업공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'ACTIVE',
      },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: '재작업',
      },
    });
    ids.operation = operation.routing_operation_id;
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP`,
        plan_date: new Date('2026-09-21T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    ids.plan = plan.production_plan_id;
    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
      },
    });
    ids.workOrder = workOrder.work_order_id;
    ids.plant = plant.plant_id;
  }

  /** 부적합 하나 — 대상 LOT 한 줄과 재작업 판정들을 함께 세운다. */
  async function makeNc(
    key: string,
    options: { affectedQty: number; rework: number[]; scrap?: number; withWorkOrder?: boolean },
  ): Promise<void> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${key}`,
        item_id: ids.item,
        plant_id: ids.plant,
        uom_id: ids.uom,
        initial_qty: options.affectedQty,
        status_code: 'DEFECTIVE',
        lot_type_code: 'PRODUCTION',
        source_type_code: 'WORK_ORDER',
        source_id: ids.workOrder,
      },
    });
    if (key === 'rework') ids.lotRework = lot.lot_id;
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${key}`,
        item_id: ids.item,
        severity_code: 'MAJOR',
        description: `${PREFIX} ${key}`,
        status_code: 'PENDING_DECISION',
        opened_at: new Date('2026-09-01T00:00:00.000Z'),
        version_no: 1,
        work_order_id: options.withWorkOrder === false ? null : ids.workOrder,
      },
    });
    ncIds[key] = Number(nc.nonconformance_id);
    await prisma.nonconformance_lot.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        lot_id: lot.lot_id,
        affected_qty: options.affectedQty,
        uom_id: ids.uom,
        quality_status_before_code: 'NORMAL',
        quality_status_after_code: 'DEFECTIVE',
      },
    });
    for (const qty of options.rework) {
      await prisma.disposition_decision.create({
        data: {
          nonconformance_id: nc.nonconformance_id,
          disposition_type_code: 'REWORK',
          decision_qty: qty,
          uom_id: ids.uom,
          reason: `${PREFIX} 재작업 판정`,
          decided_by: ids.user,
          decided_at: new Date('2026-09-02T00:00:00.000Z'),
        },
      });
    }
    if (options.scrap !== undefined) {
      await prisma.disposition_decision.create({
        data: {
          nonconformance_id: nc.nonconformance_id,
          disposition_type_code: 'SCRAP',
          decision_qty: options.scrap,
          uom_id: ids.uom,
          reason: `${PREFIX} 폐기 판정`,
          decided_by: ids.user,
          decided_at: new Date('2026-09-02T00:00:00.000Z'),
        },
      });
    }
  }

  async function makeNonconformances(): Promise<void> {
    await makeNc('rework', { affectedQty: 100, rework: [60] });
    /* 판정 30 인데 31 을 발행하려 한다 — 잔량 초과 갈래. */
    await makeNc('exceed', { affectedQty: 100, rework: [30] });
    /* 폐기 판정만 있다 — 재작업 근거가 없다. */
    await makeNc('scrapOnly', { affectedQty: 50, rework: [], scrap: 50 });
    /* 원천 W/O 가 없다 — 승계할 생산계획이 없다. */
    await makeNc('noWorkOrder', { affectedQty: 50, rework: [50], withWorkOrder: false });
    await makeNc('stale', { affectedQty: 50, rework: [50] });
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    const byItem = { item: { item_code: { startsWith: `${PREFIX}-IT` } } };
    /* 발행된 재작업 W/O 와 원천 W/O 를 함께 — 품목으로 건다(발행분은 번호를 채번이 짓는다). */
    await prisma.work_order.deleteMany({ where: { item: { item_code: { startsWith: `${PREFIX}-IT` } } } });
    await prisma.disposition_decision.deleteMany({ where: { nonconformance: byItem } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: byItem } });
    await prisma.nonconformance.deleteMany({ where: byItem });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: `${PREFIX}-` } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: `${PREFIX}-` } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: `${PREFIX}-` } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: `${PREFIX}-` } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: `${PREFIX}-` } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: `${PREFIX}-` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: `${PREFIX}-LE` } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user !== null) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role !== null) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
