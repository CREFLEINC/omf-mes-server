/**
 * 추적 시스템 연동이 부르는 생산 쪽 입구 — 실적(`recordWithin`)·마감(`closeWithin`)·취소(`cancelWithin`)를 호출자의 트랜잭션 안에서
 * (flowtrack 연동 제안 §8 의 7 · 10-1).
 *
 * 실적은 PL13 시스템 작업자로 쓰고 LOT 을 정상으로 올린다. 마감은 자동 흐름이 세운 계획의 W/O 만 배포 상태에서 하고,
 * 그 W/O 는 ERP 생산입고 송신·마감 알림이 없다. 관리웹·POP 은 자동 W/O 를 마감하지 않는다 — flowtrack 이 마감 보고로 닫는다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { IF_WO_CLOSE } from '../src/core/outbox';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductionResultService } from '../src/production/production-result/production-result.service';
import { WorkOrderCancelService } from '../src/production/work-order/work-order-cancel.service';
import { WorkOrderCloseService } from '../src/production/work-order/work-order-close.service';

const PREFIX = `E2E_TRC_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');

describe('추적 시스템 연동 — 실적·마감 입구 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let results: ProductionResultService;
  let closes: WorkOrderCloseService;
  let cancels: WorkOrderCancelService;
  let cookie: string;
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    results = app.get(ProductionResultService);
    closes = app.get(WorkOrderCloseService);
    cancels = app.get(WorkOrderCancelService);
    await fixtures();
  });

  afterAll(async () => {
    await app.close();
  });

  const record = (workOrderId: bigint, lotId: bigint, goodQty: number) =>
    prisma.$transaction((tx) =>
      results.recordWithin(tx, {
        workOrderId: Number(workOrderId), goodQty, uomId: Number(ids.uom), lotId, occurredAt: OCCURRED,
        resultSourceCode: 'TRACKING_SYSTEM', workerId: ids.worker, idempotencyKey: randomUUID(), productionResultNo: `${PREFIX}-PR-${++seq}`,
      }),
    );

  it('실적 — 시스템 작업자로 쓰고 LOT 을 정상으로 올린다 · 조회 응답이 계약에 맞는다', async () => {
    const { workOrderId, lotId } = await releasedWorkOrder(true);
    const view = await record(workOrderId, lotId, 4);

    const row = await prisma.production_result.findUniqueOrThrow({ where: { production_result_id: BigInt(view.productionResultId) } });
    expect(row).toMatchObject({ result_source_code: 'TRACKING_SYSTEM', worker_id: ids.worker, created_by: null });
    expect(await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } })).toMatchObject({ status_code: 'NORMAL', lifecycle_status_code: 'ACTIVE' });
    expect(await prisma.lot_status_event.findMany({ where: { lot_id: lotId } })).toEqual([
      expect.objectContaining({ new_status_code: 'NORMAL', changed_worker_id: ids.worker, changed_by: null }),
    ]);

    const response = await request(app.getHttpServer())
      .get(`/api/production/production-results/${view.productionResultId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.resultSourceCode).toBe('TRACKING_SYSTEM');
    const validate = responseValidator('GET /production/production-results/{productionResultId}');
    expect(validate(response.body) ? [] : validate.errors).toEqual([]);
  });

  it('마감 — 자동 계획 W/O 를 배포 상태에서 마감한다 · 시스템 작업자 · ERP 생산입고 송신·마감 알림이 없다', async () => {
    const { workOrderId, lotId } = await releasedWorkOrder(true);
    await prisma.$transaction(async (tx) => {
      await results.recordWithin(tx, {
        workOrderId: Number(workOrderId), goodQty: 10, uomId: Number(ids.uom), lotId, occurredAt: OCCURRED,
        resultSourceCode: 'TRACKING_SYSTEM', workerId: ids.worker, idempotencyKey: randomUUID(), productionResultNo: `${PREFIX}-PR-${++seq}`,
      });
      await closes.closeWithin(tx, Number(workOrderId), {}, ids.worker);
    });

    expect(await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).toMatchObject({
      status_code: 'CLOSED', closed_at: expect.any(Date), closed_worker_id: ids.worker, close_judgment_code: 'NORMAL', updated_by: null,
    });
    expect(await prisma.integration_message.count({ where: { interface_code: IF_WO_CLOSE, target_id: workOrderId } })).toBe(0);
    expect(await prisma.notification_event.count({ where: { aggregate_type_code: 'WORK_ORDER', aggregate_id: workOrderId } })).toBe(0);
  });

  it('사람이 세운 계획의 W/O 는 서버 마감도 배포 상태에서 받지 않는다', async () => {
    const { workOrderId, lotId } = await releasedWorkOrder(false);
    await expect(
      prisma.$transaction(async (tx) => {
        await results.recordWithin(tx, {
          workOrderId: Number(workOrderId), goodQty: 10, uomId: Number(ids.uom), lotId, occurredAt: OCCURRED,
          resultSourceCode: 'TRACKING_SYSTEM', workerId: ids.worker, idempotencyKey: randomUUID(), productionResultNo: `${PREFIX}-PR-${++seq}`,
        });
        await closes.closeWithin(tx, Number(workOrderId), {}, ids.worker);
      }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'STATE_LOCKED' })] });
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('RELEASED');
  });

  it('마감 — 미달 마감의 사유가 쓰지 않는 코드면 거절한다', async () => {
    const { workOrderId, lotId } = await releasedWorkOrder(true);
    await expect(
      prisma.$transaction(async (tx) => {
        await results.recordWithin(tx, {
          workOrderId: Number(workOrderId), goodQty: 4, uomId: Number(ids.uom), lotId, occurredAt: OCCURRED,
          resultSourceCode: 'TRACKING_SYSTEM', workerId: ids.worker, idempotencyKey: randomUUID(), productionResultNo: `${PREFIX}-PR-${++seq}`,
        });
        await closes.closeWithin(tx, Number(workOrderId), { remainderDispositionCode: 'WRITE_OFF', reasonCode: `${PREFIX}-NONE` }, ids.worker);
      }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ field: 'reasonCode', code: 'INVALID' })] });
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('RELEASED');
  });

  it.each(['RELEASED', 'IN_PROGRESS'])('관리웹 :close 는 자동 계획 W/O 를 받지 않는다(%s) — flowtrack 이 마감한다', async (status) => {
    const { workOrderId } = await releasedWorkOrder(true);
    await prisma.work_order.update({ where: { work_order_id: workOrderId }, data: { status_code: status } });
    const response = await request(app.getHttpServer())
      .post(`/api/production/work-orders/${workOrderId}:close`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({})
      .expect(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', message: expect.stringContaining('flowtrack') });
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe(status);
  });

  it('취소 — 호출자의 트랜잭션 안에서 W/O 를 취소하고 생산 LOT 을 폐번한다 · 쓰지 않는 사유는 거절한다', async () => {
    const { workOrderId, lotId } = await releasedWorkOrder(true);
    await expect(prisma.$transaction((tx) => cancels.cancelWithin(tx, Number(workOrderId), { reasonCode: `${PREFIX}-NONE` })))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ field: 'reasonCode', code: 'INVALID' })] });

    await prisma.$transaction((tx) => cancels.cancelWithin(tx, Number(workOrderId), { reasonCode: 'PLAN_CHANGE' }));

    expect(await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).toMatchObject({
      status_code: 'CANCELLED', cancellation_reason_code: 'PLAN_CHANGE', updated_by: null,
    });
    expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } })).lifecycle_status_code).toBe('VOIDED');
  });

  /** 배포 상태의 W/O 와 그 생산 LOT 하나 — 자동 흐름이 세운 계획이면 `automatic`. */
  async function releasedWorkOrder(automatic: boolean): Promise<{ workOrderId: bigint; lotId: bigint }> {
    const key = ++seq;
    const order = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${key}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: ids.item,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED',
    } });
    const plan = await prisma.production_plan.create({ data: {
      production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP-${key}`, plan_date: OCCURRED, planned_qty: 10,
      uom_id: ids.uom, bom_id: ids.bom, routing_id: ids.routing, status_code: 'CONFIRMED', confirmed_at: OCCURRED,
      created_automatically: automatic,
    } });
    const workOrder = await prisma.work_order.create({ data: {
      work_order_no: `${PREFIX}-WO-${key}`, production_plan_id: plan.production_plan_id, routing_operation_id: ids.operation,
      item_id: ids.item, order_qty: 10, uom_id: ids.uom, status_code: 'RELEASED', released_at: OCCURRED,
    } });
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${key}`, item_id: ids.item, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: 10,
      uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrder.work_order_id, status_code: 'INSPECTION_PENDING',
      lifecycle_status_code: 'WAITING', work_order_lot_seq: 1,
    } });
    return { workOrderId: workOrder.work_order_id, lotId: lot.lot_id };
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    ids.plant = (await prisma.plant.create({ data: {
      plant_code: PREFIX, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    ids.item = (await prisma.item.create({ data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'FINISHED', base_uom_id: ids.uom } })).item_id;
    const process = await prisma.process.create({ data: { process_code: PREFIX, process_name: '조립', process_type_code: 'ASSEMBLY' } });
    ids.routing = (await prisma.routing.create({ data: {
      item_id: ids.item, routing_code: `RT-${PREFIX}`, routing_version: 1, status_code: 'CONFIRMED',
    } })).routing_id;
    ids.operation = (await prisma.routing_operation.create({ data: {
      routing_id: ids.routing, operation_seq: 10, process_id: process.process_id, operation_name: '조립',
    } })).routing_operation_id;
    ids.bom = (await prisma.bom.create({ data: {
      parent_item_id: ids.item, plant_id: ids.plant, bom_code: `ERP-${PREFIX}`, bom_version: 1, status_code: 'CONFIRMED', is_default: true,
      effective_from: OCCURRED, base_qty: 1, base_uom_id: ids.uom,
    } })).bom_id;
    ids.worker = (await prisma.worker.create({ data: {
      worker_no: `${PREFIX}-SYS`, worker_name: '추적 시스템 연동', plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED',
    } })).worker_id;

    const user = await prisma.app_user.create({ data: { login_id: PREFIX, user_name: PREFIX, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: PREFIX, role_name: '연동 실적·마감 시험' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-05' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  }
});

function responseValidator(operation: string) {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}
