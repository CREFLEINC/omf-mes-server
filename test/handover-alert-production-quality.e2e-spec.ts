/**
 * 인계 작업 알림 — 생산·품질 T6~T10(omf-all-around#190 · specs/002 research R-3).
 *
 * W/O 배포(일반 T6 · 긴급 T7, 배포 경로의 자재 피킹 T2), 출하지시 OQC 의뢰(T8, 출하지시 1건에 1건),
 * 재작업 W/O 발행(T9), 입하 IQC 의뢰(T10, 입하 1건에 1건). 공장 × 종류 담당자에게만 간다.
 * ⚠ 같은 DB 를 다른 스위트와 쓰므로 접두어(`ROOT`)로 짚는다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorkOrderHandoverNotifier } from '../src/production/work-order/work-order-handover';

const ROOT = 'E2EHOPQ';
const PREFIX = `${ROOT}${randomUUID().slice(0, 6).toUpperCase()}`;
const DAY = '2026-10-28';
const AT = '2026-10-28T02:00:00.000Z';

describe('인계 작업 알림 — 생산·품질 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let seq = 0;
  /** 공급사 LOT 번호의 번호 칸 — 앞 시험이 0001·0002 를 쓴다. */
  let lotSerial = 2;
  const ids: Record<string, bigint> = {};
  const users: Record<string, bigint> = {};
  const roleIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await fixtures();
    for (const type of [
      'WORK_ORDER_RELEASED',
      'EMERGENCY_WORK_ORDER_RELEASED',
      'MATERIAL_PICKING_REQUESTED',
      'OQC_INSPECTION_REQUESTED',
      'REWORK_WORK_ORDER_CREATED',
      'IQC_INSPECTION_REQUESTED',
    ]) {
      await configure(type, [users.U1, users.U2]);
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US1-5 T6 일반 W/O 배포 → 작업 시작 알림 1건(T7 은 없음), 배포가 만든 피킹 지시에 T2 도 간다', async () => {
    const workOrderId = await workOrder('NORMAL');
    await release(workOrderId).expect(200);

    const [event] = await eventsOf('WORK_ORDER_RELEASED', 'WORK_ORDER', workOrderId);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: null });
    expect(event.payload).toMatchObject({ wo_no: `${PREFIX}-WO${seq}`, process: '사출', plan_qty: expect.stringMatching(/^100 /) });
    expect(await eventsOf('EMERGENCY_WORK_ORDER_RELEASED', 'WORK_ORDER', workOrderId)).toHaveLength(0);
    expect(await prisma.notification.count({ where: { notification_event_id: event.notification_event_id } })).toBe(2);

    const pickings = await prisma.picking_order.findMany({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', warehouse_id: ids.whM },
      select: { picking_order_id: true },
      orderBy: { picking_order_id: 'desc' },
      take: 1,
    });
    expect(pickings).toHaveLength(1);
    expect(await eventsOf('MATERIAL_PICKING_REQUESTED', 'PICKING_ORDER', pickings[0].picking_order_id)).toHaveLength(1);
  });

  it('US1-5 T7 긴급 W/O 배포 → 긴급 W/O 알림 1건, 작업 시작(T6)은 생기지 않는다', async () => {
    const workOrderId = await workOrder('EMERGENCY');
    await release(workOrderId).expect(200);

    expect(await eventsOf('EMERGENCY_WORK_ORDER_RELEASED', 'WORK_ORDER', workOrderId)).toHaveLength(1);
    expect(await eventsOf('WORK_ORDER_RELEASED', 'WORK_ORDER', workOrderId)).toHaveLength(0);
  });

  it('FR-002 같은 W/O 를 다시 알려도(재시도) 사건은 하나다', async () => {
    const workOrderId = await workOrder('NORMAL');
    await release(workOrderId).expect(200);
    await prisma.$transaction((tx) => app.get(WorkOrderHandoverNotifier).released(tx, workOrderId));
    expect(await eventsOf('WORK_ORDER_RELEASED', 'WORK_ORDER', workOrderId)).toHaveLength(1);
  });

  it('US1-5 FR-002 T8 OQC 의뢰가 품목 둘에 생겨도 출하지시 1건에 알림 1건, 내용에 의뢰 수', async () => {
    const requestId = await shipmentRequest(ids.plant, true);
    const requests = await prisma.inspection_request.count({
      where: { inspection_type_code: 'OQC', target_type_code: 'SHIPMENT_REQUEST', target_id: requestId },
    });
    expect(requests).toBe(2);

    const events = await eventsOf('OQC_INSPECTION_REQUESTED', 'SHIPMENT_REQUEST', requestId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ request_count: 2, ship_date: '30/10/2026' });
  });

  it('US1-5 T8 이행 공장이 없으면 OQC 알림은 없다', async () => {
    const requestId = await shipmentRequest(null, true);
    expect(await eventsOf('OQC_INSPECTION_REQUESTED', 'SHIPMENT_REQUEST', requestId)).toHaveLength(0);
  });

  it('US1-5 T9 재작업 W/O 발행 → 원천 계획 공장의 담당자에게 재작업 알림, 내용에 부적합 번호', async () => {
    const source = await workOrder('NORMAL');
    const nonconformanceId = await nonconformance(source);

    const response = await request(app.getHttpServer())
      .post(`/api/quality/nonconformances/${nonconformanceId}:issue-rework-work-order`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ orderQty: 10, routingOperationId: Number(ids.operation) })
      .expect(201);
    const reworkId = BigInt(response.body.workOrderId);

    const [event] = await eventsOf('REWORK_WORK_ORDER_CREATED', 'WORK_ORDER', reworkId);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED' });
    expect(event.payload).toMatchObject({ ncr_no: `${PREFIX}-NC`, qty: expect.stringMatching(/^10 /), actor: `${PREFIX} ADMIN` });
  });

  it('US1-5 FR-002 T10 입하에 IQC LOT 이 둘이어도 입하 1건에 알림 1건, 내용에 LOT 수·공급사', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        supplierId: Number(ids.supplier),
        plantId: Number(ids.plant),
        receiptDatetime: AT,
        businessDate: DAY,
        occurredAt: AT,
        exceptionTypeCode: 'CUSTOMER_SUPPLY',
        exceptionReason: '무발주 도착',
        lines: [1, 2].map((serial) => ({
          itemId: Number(ids.itemIqc),
          receivedQty: 10,
          uomId: Number(ids.uom),
          supplierLotNo: `${PREFIX}IQC|10|261028|${PREFIX}S|${String(serial).padStart(4, '0')}`,
          supplierLotMissing: false,
        })),
      })
      .expect(201);
    const receiptId = BigInt(response.body.inboundReceipt.inboundReceiptId);

    const events = await eventsOf('IQC_INSPECTION_REQUESTED', 'INBOUND_RECEIPT', receiptId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ lot_count: 2, supplier: `${PREFIX} 공급사` });
    const notes = await prisma.notification.findMany({ where: { notification_event_id: events[0].notification_event_id } });
    expect(notes.map((n) => n.title)).toEqual(['IQC 수입검사', 'IQC 수입검사']);

    // 알림센터는 T10 을 IQC 화면으로 보낼 대상(입하)을 싣는다(research R-8).
    const inbox = await request(app.getHttpServer())
      .get('/api/app/notifications')
      .query({ occurredFrom: new Date(Date.now() - 3_600_000).toISOString(), occurredTo: new Date(Date.now() + 3_600_000).toISOString() })
      .set('Cookie', `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(users.U1), typ: 'session' })}`)
      .expect(200);
    const iqc = inbox.body.items.find((n: { eventCode: string }) => n.eventCode === 'IQC_INSPECTION_REQUESTED');
    expect(iqc).toMatchObject({ targetTypeCode: 'INBOUND_RECEIPT', targetId: Number(receiptId) });
  });

  it('US1-5 FR-002 T10 :split·:per-line 도 입하 1건에 알림 1건이다', async () => {
    const part = () => ({ supplierId: Number(ids.supplier), plantId: Number(ids.plant), receiptDatetime: AT, lines: [iqcLine()] });
    const split = await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts:split')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ mode: 'BOTH', normal: part(), excess: part(), businessDate: DAY, occurredAt: AT })
      .expect(201);
    const perLine = await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts:per-line')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        supplierId: Number(ids.supplier),
        plantId: Number(ids.plant),
        receiptDatetime: AT,
        businessDate: DAY,
        occurredAt: AT,
        exceptionTypeCode: 'CUSTOMER_SUPPLY',
        exceptionReason: '무발주 도착',
        lines: [iqcLine(), iqcLine()],
      })
      .expect(201);

    const receiptIds = [
      ...split.body.created.map((r: { inboundReceiptId: number }) => r.inboundReceiptId),
      ...perLine.body.created.map((r: { inboundReceipt: { inboundReceiptId: number } }) => r.inboundReceipt.inboundReceiptId),
    ];
    expect(receiptIds).toHaveLength(4);
    for (const receiptId of receiptIds) {
      const events = await eventsOf('IQC_INSPECTION_REQUESTED', 'INBOUND_RECEIPT', BigInt(receiptId));
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ lot_count: 1 });
    }
  });

  it('US1-5 T10 POST /trace/lots 단건 등록이 IQC 의뢰를 세우면 LOT 1건에 알림 1건', async () => {
    // 공장을 다시 쓰므로 이 실행의 공급사가 만든 입하에 줄을 단다.
    const receipt = await prisma.inbound_receipt.findFirstOrThrow({
      where: { plant_id: ids.plant, supplier_id: ids.supplier },
      select: { inbound_receipt_id: true },
    });
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: receipt.inbound_receipt_id,
        line_no: 99,
        item_id: ids.itemIqc,
        received_qty: 10,
        uom_id: ids.uom,
        supplier_lot_label_attached: false,
        inspection_required: true,
        status_code: 'REGISTERED',
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        itemId: Number(ids.itemIqc),
        lotTypeCode: 'MATERIAL',
        plantId: Number(ids.plant),
        initialQty: 10,
        uomId: Number(ids.uom),
        sourceTypeCode: 'INBOUND_RECEIPT_LINE',
        sourceId: Number(line.inbound_receipt_line_id),
        numberSourceCode: 'MES',
        businessDate: DAY,
        occurredAt: AT,
      })
      .expect(201);
    const lotId = BigInt(created.body.lot.lotId);

    const events = await eventsOf('IQC_INSPECTION_REQUESTED', 'LOT', lotId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ receipt_no: created.body.lot.lotNo, lot_count: 1, supplier: `${PREFIX} 공급사` });
  });

  function iqcLine() {
    lotSerial += 1;
    return {
      itemId: Number(ids.itemIqc),
      receivedQty: 10,
      uomId: Number(ids.uom),
      supplierLotNo: `${PREFIX}IQC|10|261028|${PREFIX}S|${String(lotSerial).padStart(4, '0')}`,
      supplierLotMissing: false,
    };
  }

  async function eventsOf(type: string, aggregate: string, id: bigint) {
    return prisma.notification_event.findMany({ where: { event_type_code: type, aggregate_type_code: aggregate, aggregate_id: id } });
  }

  async function configure(type: string, recipients: bigint[]): Promise<void> {
    await request(app.getHttpServer())
      .put(`/api/app/handover-alert-settings/${ids.plant}/${type}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ enabled: true, zaloEnabled: false, recipientUserIds: recipients.map(Number) })
      .expect(200);
  }

  function release(workOrderId: bigint) {
    return request(app.getHttpServer())
      .post(`/api/production/work-orders/${workOrderId}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: 100 });
  }

  async function workOrder(type: string): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO${++seq}`,
        production_plan_id: ids.plan,
        routing_operation_id: ids.operation,
        item_id: ids.itemFg,
        order_qty: 100,
        uom_id: ids.uom,
        work_order_type_code: type,
        status_code: 'PLANNED',
        production_line_id: ids.line,
        default_wip_location_id: ids.locWip,
        default_fg_location_id: ids.locWip,
        default_scrap_location_id: ids.locWip,
      },
    });
    return row.work_order_id;
  }

  async function shipmentRequest(plantId: bigint | null, inspect: boolean): Promise<bigint> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/shipment-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        customerId: Number(ids.customer),
        shipToPartnerId: Number(ids.customer),
        requestedShipDate: '2026-10-30',
        ...(plantId === null ? {} : { fulfillmentPlantId: Number(plantId) }),
        lines: [ids.itemOqc1, ids.itemOqc2].map((itemId) => ({
          itemId: Number(itemId),
          requestedQty: 5,
          allocatedQty: 5,
          uomId: Number(ids.uom),
          shippingInspectionRequired: inspect,
        })),
      })
      .expect(201);
    return BigInt(response.body.shipmentRequestId);
  }

  async function nonconformance(workOrderId: bigint): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-NCLOT`,
        item_id: ids.itemFg,
        plant_id: ids.plant,
        uom_id: ids.uom,
        initial_qty: 50,
        status_code: 'DEFECTIVE',
        lot_type_code: 'PRODUCTION',
        source_type_code: 'WORK_ORDER',
        source_id: workOrderId,
      },
    });
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC`,
        item_id: ids.itemFg,
        severity_code: 'MAJOR',
        description: PREFIX,
        status_code: 'PENDING_DECISION',
        opened_at: new Date(AT),
        version_no: 1,
        work_order_id: workOrderId,
      },
    });
    await prisma.nonconformance_lot.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        lot_id: lot.lot_id,
        affected_qty: 50,
        uom_id: ids.uom,
        quality_status_before_code: 'NORMAL',
        quality_status_after_code: 'DEFECTIVE',
      },
    });
    await prisma.disposition_decision.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        disposition_type_code: 'REWORK',
        decision_qty: 30,
        uom_id: ids.uom,
        reason: `${PREFIX} 재작업 판정`,
        decided_by: users.ADMIN,
        decided_at: new Date(AT),
      },
    });
    return nc.nonconformance_id;
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    // 공장은 고정 코드로 다시 쓴다 — 원장이 붙어 지울 수 없어, 실행마다 새로 만들면 공장 목록(mdm-reference 등)의 쪽을 밀어낸다.
    ids.plant = (
      (await prisma.plant.findFirst({ where: { plant_code: `${ROOT}-P` } })) ??
      await prisma.plant.create({
        data: {
          plant_code: `${ROOT}-P`,
          plant_name: `${ROOT} 공장`,
          legal_entity_id: base.legal_entity_id,
          business_unit_id: unit.business_unit_id,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    const item = async (code: string, type: string, inspection = false) =>
      (
        await prisma.item.create({
          data: { item_code: code, item_name: `${PREFIX} ${code}`, item_type_code: type, base_uom_id: ids.uom, inspection_required: inspection },
        })
      ).item_id;
    ids.itemFg = await item(`${PREFIX}FG`, 'FINISHED');
    ids.itemA = await item(`${PREFIX}A`, 'RAW_MATERIAL');
    ids.itemIqc = await item(`${PREFIX}IQC`, 'RAW_MATERIAL', true);
    ids.itemOqc1 = await item(`${PREFIX}O1`, 'FINISHED');
    ids.itemOqc2 = await item(`${PREFIX}O2`, 'FINISHED');
    for (const itemId of [ids.itemOqc1, ids.itemOqc2]) {
      const plan = await prisma.inspection_plan.create({
        data: { inspection_plan_code: `${PREFIX}-OQC-${itemId}`, inspection_plan_name: `${PREFIX} OQC`, item_id: itemId, inspection_type_code: 'OQC', is_active: true },
      });
      await prisma.inspection_plan_version.create({
        data: {
          inspection_plan_id: plan.inspection_plan_id,
          plan_version: 1,
          effective_from: new Date('2020-01-01'),
          sampling_method_code: 'FULL_INSPECTION',
          inspection_frequency_code: 'PRODUCTION_LOT',
          status_code: 'CONFIRMED',
        },
      });
    }

    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' } });
    const routing = await prisma.routing.create({
      data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    ids.operation = (
      await prisma.routing_operation.create({
        data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
      })
    ).routing_operation_id;
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: ids.itemFg,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: ids.uom,
      },
    });
    await prisma.bom_component.create({
      data: { bom_id: bom.bom_id, component_item_id: ids.itemA, required_qty: 1, routing_operation_id: ids.operation, uom_id: ids.uom, sequence_no: 1 },
    });

    const warehouse = async (code: string, type: string) => {
      const wh = await prisma.warehouse.create({
        data: {
          plant_id: ids.plant,
          business_unit_id: unit.business_unit_id,
          warehouse_code: `${PREFIX}-${code}`,
          warehouse_name: `${PREFIX} ${code}`,
          warehouse_type_code: type,
          management_level_code: 'WAREHOUSE',
        },
      });
      const location = await prisma.location.create({
        data: { warehouse_id: wh.warehouse_id, location_code: `${PREFIX}-${code}-01`, location_name: code, location_type_code: 'DEFAULT' },
      });
      return { warehouseId: wh.warehouse_id, locationId: location.location_id };
    };
    const wip = await warehouse('WIP', 'GENERAL');
    const material = await warehouse('M1', 'MATERIAL');
    ids.locWip = wip.locationId;
    ids.whM = material.warehouseId;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-A1`,
        item_id: ids.itemA,
        lot_type_code: 'MATERIAL',
        plant_id: ids.plant,
        initial_qty: 10000,
        uom_id: ids.uom,
        source_type_code: 'GOODS_RECEIPT',
        source_id: 0,
        status_code: 'NORMAL',
      },
    });
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: base.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant,
        warehouse_id: material.warehouseId,
        location_id: material.locationId,
        item_id: ids.itemA,
        lot_id: lot.lot_id,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: 10000,
        uom_id: ids.uom,
      },
    });

    ids.line = (
      await prisma.production_line.create({ data: { plant_id: ids.plant, line_code: `${PREFIX}-LN`, line_name: `${PREFIX} 라인` } })
    ).production_line_id;
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant,
        item_id: ids.itemFg,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'RECEIVED',
      },
    });
    ids.plan = (
      await prisma.production_plan.create({
        data: {
          production_order_id: order.production_order_id,
          plan_no: `${PREFIX}-PP`,
          plan_date: new Date('2026-10-28T00:00:00.000Z'),
          planned_qty: 100,
          uom_id: ids.uom,
          bom_id: bom.bom_id,
          routing_id: routing.routing_id,
          status_code: 'CONFIRMED',
        },
      })
    ).production_plan_id;
    ids.customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}C`, partner_name: `${PREFIX} 고객` } })).partner_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}S`, partner_name: `${PREFIX} 공급사` } })).partner_id;

    for (const [key, phone] of [['ADMIN', null], ['U1', '84912340002'], ['U2', null]] as const) {
      users[key] = (
        await prisma.app_user.create({ data: { login_id: `${PREFIX}_${key}`, user_name: `${PREFIX} ${key}`, status_code: 'EMPLOYED', phone_number: phone } })
      ).app_user_id;
    }
    await prisma.user_data_scope.create({ data: { app_user_id: users.ADMIN, business_unit_id: unit.business_unit_id, plant_id: ids.plant } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '인계 생산 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.createMany({
      data: ['W-CO-14', 'W-02-04', 'W-01-03', 'W-04-01', 'W-03-10', 'M-01-01'].map((code) => ({ role_id: role.role_id, permission_code: code })),
    });
    await prisma.user_role.create({ data: { app_user_id: users.ADMIN, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(users.ADMIN), typ: 'session' })}`;
  }

  /** 알림·설정·권한은 지운다. 업무 행은 접두어 공장에 묶여 남는다 — 다른 스위트의 전역 목록과 겹치지 않는 축이다. */
  async function cleanup(): Promise<void> {
    const userIds = Object.values(users);
    const events = await prisma.notification_event.findMany({
      where: { notification: { some: { recipient_user_id: { in: userIds } } } },
      select: { notification_event_id: true },
    });
    const eventIds = events.map((e) => e.notification_event_id);
    await prisma.zalo_delivery.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    const settings = await prisma.handover_alert_setting.findMany({ where: { plant_id: ids.plant }, select: { handover_alert_setting_id: true } });
    await prisma.handover_alert_recipient.deleteMany({ where: { handover_alert_setting_id: { in: settings.map((s) => s.handover_alert_setting_id) } } });
    await prisma.handover_alert_setting.deleteMany({ where: { plant_id: ids.plant } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    // 시험 계정은 사용 중지한다 — 활성 계정 전부를 세는 화면(공지 확인 현황 등)의 쪽에 끼어든다.
    await prisma.app_user.updateMany({ where: { app_user_id: { in: userIds } }, data: { is_active: false } });
    await deleteDocuments();
  }

  /**
   * 전역 집계(대시보드 출하·검사 등)에 끼어드는 전표는 지운다 — 공장 미지정 출하지시는 «어느 공장을 골라도» 집계된다.
   * 이전 실행의 찌꺼기까지 접두어 뿌리로 짚는다. ⛔ 원장·LOT 은 남긴다(원장 트리거가 삭제를 막는다).
   */
  async function deleteDocuments(): Promise<void> {
    const requests = `SELECT shipment_request_id FROM logistics.shipment_request WHERE customer_id IN (SELECT partner_id FROM mdm.partner WHERE partner_code LIKE '${ROOT}%')`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${ROOT}%')`;
    for (const statement of [
      `DELETE FROM quality.inspection_request WHERE (target_type_code = 'SHIPMENT_REQUEST' AND target_id IN (${requests})) OR lot_id IN (${lots})`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_id IN (${requests})`,
    ]) {
      await prisma.$executeRawUnsafe(statement);
    }
  }
});
