/**
 * 인계 작업 알림 — 물류 T1~T5(omf-all-around#190 · specs/002 research R-3).
 *
 * 업무 오퍼레이션이 같은 트랜잭션에서 알림 사건·알림센터 알림·Zalo 대기(priority 1)를 쓴다.
 * 수신자는 공장 × 종류 담당자(`handover_alert_setting`)이고, 기존 부서 설정과 무관하다.
 * ⚠ 같은 DB 를 다른 스위트와 쓰므로 정리는 접두어(`PREFIX`)와 만든 id 로만 한다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { NotificationEmitter } from '../src/core/notification';
import { LogisticsHandoverNotifier } from '../src/logistics/logistics-handover';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = 'E2E_HOLOG_';
const PREFIX = `${ROOT}${randomUUID().slice(0, 6)}`;
const DAY = '2026-10-28';
const AT = '2026-10-28T02:00:00.000Z';
const WORKER_NO = `${PREFIX}W`;

describe('인계 작업 알림 — 물류 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids = {
    businessUnit: 0n,
    plant1: 0n,
    plant2: 0n,
    uom: 0n,
    itemA: 0n,
    itemB: 0n,
    whA: 0n,
    whB: 0n,
    whC: 0n,
    locA: 0n,
    locB: 0n,
    locC: 0n,
    workOrder: 0n,
    customer: 0n,
  };
  const users: Record<string, bigint> = {};
  const roleIds: bigint[] = [];
  const created = { requests: [] as bigint[] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await fixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  it('US1-4 적치 알림이 꺼져 있으면 입고는 사건만 SKIPPED EVENT_DISABLED 로 남기고 알림은 0건이다', async () => {
    const receiptId = await receive(ids.whA, ids.locA, ids.itemA, ids.plant1);

    const events = await eventsOf('PUTAWAY_REQUESTED', 'GOODS_RECEIPT', receiptId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: 'EVENT_DISABLED', department_id: null });
    expect(await prisma.notification.count({ where: { notification_event_id: events[0].notification_event_id } })).toBe(0);
  });

  it('US1-5 T1 입고 1건에 적치 알림 1건 — 담당자 알림센터, 내용에 적치 지시 수', async () => {
    await configure(ids.plant1, 'PUTAWAY_REQUESTED', [users.U1], false);
    const receiptId = await receive(ids.whA, ids.locA, ids.itemA, ids.plant1);

    const [event] = await eventsOf('PUTAWAY_REQUESTED', 'GOODS_RECEIPT', receiptId);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: null });
    expect(event.payload).toMatchObject({ task_count: 1, warehouse: `${PREFIX} 창고A`, actor: `${PREFIX} ADMIN` });
    const notes = await prisma.notification.findMany({ where: { notification_event_id: event.notification_event_id } });
    expect(notes.map((n) => n.recipient_user_id)).toEqual([users.U1]);
    expect(notes[0].title).toBe('적치');
    expect(await prisma.zalo_delivery.count({ where: { notification_event_id: event.notification_event_id } })).toBe(0);
  });

  it('US1-1 US1-2 US1-3 추가 출고 요청이 창고 A·B 두 피킹 지시를 만들면 알림 2건 — U1·U2 알림센터, U1 만 Zalo(priority 1)', async () => {
    await receive(ids.whB, ids.locB, ids.itemB, ids.plant1);
    await configure(ids.plant1, 'MATERIAL_PICKING_REQUESTED', [users.U1, users.U2], true);

    const response = await request(app.getHttpServer())
      .post('/api/logistics/material-issue-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        workOrderId: Number(ids.workOrder),
        destinationLocationId: Number(ids.locA),
        businessDate: DAY,
        occurredAt: AT,
        lines: [
          { itemId: Number(ids.itemA), requestedQty: 3, uomId: Number(ids.uom) },
          { itemId: Number(ids.itemB), requestedQty: 2, uomId: Number(ids.uom) },
        ],
      })
      .expect(201);
    const requestId = BigInt(response.body.materialIssueRequest.materialIssueRequestId);
    const pickings = await prisma.picking_order.findMany({
      where: { source_document_id: requestId, source_document_type_code: 'MATERIAL_ISSUE_REQUEST' },
      select: { picking_order_id: true, picking_order_no: true, warehouse_id: true },
    });
    expect(pickings.map((p) => p.warehouse_id).sort()).toEqual([ids.whA, ids.whB].sort());

    for (const picking of pickings) {
      const [event] = await eventsOf('MATERIAL_PICKING_REQUESTED', 'PICKING_ORDER', picking.picking_order_id);
      expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED', department_id: null });
      expect(event.payload).toMatchObject({ picking_no: picking.picking_order_no, wo_no: `${PREFIX}-WO`, item_count: 1 });
      const notes = await prisma.notification.findMany({ where: { notification_event_id: event.notification_event_id } });
      expect(notes.map((n) => n.recipient_user_id).sort()).toEqual([users.U1, users.U2].sort());
      expect(notes[0].title).toBe('자재 출고 피킹');
      expect(notes[0].message).toContain(picking.picking_order_no);

      const deliveries = await prisma.zalo_delivery.findMany({ where: { notification_event_id: event.notification_event_id } });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ recipient_user_id: users.U1, priority: 1, status_code: 'PENDING', department_id: null });
      // jsonb 는 키 순서를 지키지 않는다 — 집합으로 본다.
      expect(Object.keys(deliveries[0].template_data as object).sort()).toEqual(
        ['picking_no', 'wo_no', 'item_count', 'warehouse', 'required_at', 'event_time'].sort(),
      );
      expect(event.payload).toMatchObject({ zaloSkippedNoPhone: 1 });
    }

    const inbox = await request(app.getHttpServer())
      .get('/api/app/notifications')
      .query({
        occurredFrom: new Date(Date.now() - 3_600_000).toISOString(),
        occurredTo: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .set('Cookie', userCookie(users.U2))
      .expect(200);
    const picks = inbox.body.items.filter((n: { eventCode: string }) => n.eventCode === 'MATERIAL_PICKING_REQUESTED');
    expect(picks).toHaveLength(2);
    // 피킹 지시는 알림센터 대상 유형 9종 밖이라 링크 없이 내용만 보인다(research R-8).
    expect(picks[0].targetTypeCode).toBeUndefined();
  });

  it('US1-5 T3 창고 이동은 «도착» 창고 공장의 담당자에게 간다', async () => {
    await configure(ids.plant2, 'STOCK_TRANSFER_ARRIVAL_PENDING', [users.U2], false);
    const lot = await receiveLot(ids.whA, ids.locA, ids.itemA, ids.plant1);

    const response = await request(app.getHttpServer())
      .post('/api/logistics/stock-transfers')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', WORKER_NO)
      .send({
        transferTypeCode: 'NORMAL',
        fromBusinessUnitId: Number(ids.businessUnit),
        toBusinessUnitId: Number(ids.businessUnit),
        fromWarehouseId: Number(ids.whA),
        toWarehouseId: Number(ids.whC),
        businessDate: DAY,
        occurredAt: AT,
        lines: [{ itemId: Number(ids.itemA), lotId: Number(lot), requestedQty: 1, uomId: Number(ids.uom), fromLocationId: Number(ids.locA), toLocationId: Number(ids.locC) }],
      })
      .expect(201);
    const transferId = BigInt(response.body.stockTransfer.stockTransferId);

    const [event] = await eventsOf('STOCK_TRANSFER_ARRIVAL_PENDING', 'STOCK_TRANSFER', transferId);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED' });
    expect(event.payload).toMatchObject({ from_warehouse: `${PREFIX} 창고A`, to_warehouse: `${PREFIX} 창고C`, item_count: 1 });
    const notes = await prisma.notification.findMany({ where: { notification_event_id: event.notification_event_id } });
    expect(notes.map((n) => n.recipient_user_id)).toEqual([users.U2]);
  });

  it('US1-5 T4 공장 있는 출하지시는 알림 1건, 공장 없는 등록은 0건이고 공장이 처음 정해질 때 1건, 바꿀 때는 없다', async () => {
    await configure(ids.plant1, 'SHIPMENT_PICKING_REQUESTED', [users.U1], false);
    await configure(ids.plant2, 'SHIPMENT_PICKING_REQUESTED', [users.U1], false);

    const withPlant = await createShipmentRequest(ids.plant1);
    const [event] = await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', withPlant);
    expect(event).toMatchObject({ dispatch_status_code: 'NOTIFIED' });
    expect(event.payload).toMatchObject({ customer: `${PREFIX} 고객`, item_count: 1, ship_date: '30/10/2026' });

    const noPlant = await createShipmentRequest(null);
    expect(await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', noPlant)).toHaveLength(0);

    await assignPlant(noPlant, ids.plant1, '1');
    expect(await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', noPlant)).toHaveLength(1);

    await assignPlant(noPlant, ids.plant2, '2');
    const after = await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', noPlant);
    expect(after).toHaveLength(1);
  });

  it('US1-5 T5 출하가 생기면 출하 창고 공장의 담당자에게 포장 알림 1건', async () => {
    await configure(ids.plant1, 'SHIPMENT_PACKING_REQUESTED', [users.U1, users.U2], true);
    const requestId = await createShipmentRequest(ids.plant1);
    const shipment = await prisma.shipment.create({
      data: { shipment_no: `${PREFIX}-SH`, shipment_request_id: requestId, warehouse_id: ids.whA, status_code: 'REGISTERED' },
    });

    await prisma.$transaction((tx) =>
      app.get(LogisticsHandoverNotifier).shipmentPacking(tx, shipment.shipment_id, Number(users.ADMIN)),
    );

    const [event] = await eventsOf('SHIPMENT_PACKING_REQUESTED', 'SHIPMENT', shipment.shipment_id);
    expect(event.payload).toMatchObject({ shipment_no: `${PREFIX}-SH`, warehouse: `${PREFIX} 창고A`, ship_date: '30/10/2026' });
    expect(await prisma.notification.count({ where: { notification_event_id: event.notification_event_id } })).toBe(2);
    expect(await prisma.zalo_delivery.count({ where: { notification_event_id: event.notification_event_id, priority: 1 } })).toBe(1);
  });

  it('US1-5 T5 긴급 직행 출하도 포장 알림 1건이고, 직행이 장부상 만든 입고에는 적치 알림(T1)이 없다', async () => {
    await configure(ids.plant1, 'SHIPMENT_PACKING_REQUESTED', [users.U1], false);
    await configure(ids.plant1, 'PUTAWAY_REQUESTED', [users.U1], false);
    const unit = ids.businessUnit;
    // 관리수준 WAREHOUSE 창고는 서버가 「창고 전체」 자리를 둔다(장부 P-145) — 직행 입고가 그 자리로 간다.
    const warehouse = await prisma.warehouse.create({
      data: { plant_id: ids.plant1, business_unit_id: unit, warehouse_code: `${PREFIX}-FG`, warehouse_name: `${PREFIX} 제품창고`, warehouse_type_code: 'FINISHED', management_level_code: 'WAREHOUSE' },
    });
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-EXPLOT`, item_id: ids.itemA, lot_type_code: 'PRODUCTION', plant_id: ids.plant1, initial_qty: 10, uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: 1, status_code: 'NORMAL' },
    });
    const requestId = await createShipmentRequest(ids.plant1);
    const line = await prisma.shipment_request_line.findFirstOrThrow({ where: { shipment_request_id: requestId } });

    const response = await request(app.getHttpServer())
      .post('/api/logistics/shipments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        shipmentRequestId: Number(requestId),
        warehouseId: Number(warehouse.warehouse_id),
        expedited: true,
        expediteReason: '고객 라인 정지',
        businessDate: DAY,
        occurredAt: AT,
        lines: [{
          shipmentRequestLineId: Number(line.shipment_request_line_id),
          shippedQty: 3,
          uomId: Number(ids.uom),
          allocations: [{ lotId: Number(lot.lot_id), allocatedQty: 3, uomId: Number(ids.uom) }],
        }],
      })
      .expect(201);
    const shipmentId = BigInt(response.body.shipmentId);

    expect(await eventsOf('SHIPMENT_PACKING_REQUESTED', 'SHIPMENT', shipmentId)).toHaveLength(1);
    const receipt = await prisma.goods_receipt.findFirstOrThrow({ where: { source_document_type_code: 'SHIPMENT', source_document_id: shipmentId } });
    expect(await eventsOf('PUTAWAY_REQUESTED', 'GOODS_RECEIPT', receipt.goods_receipt_id)).toHaveLength(0);
  });

  it('FR-002 같은 대상·같은 종류는 다시 불러도 한 번이다', async () => {
    const requestId = await createShipmentRequest(ids.plant1);
    await prisma.$transaction((tx) => app.get(LogisticsHandoverNotifier).shipmentPicking(tx, requestId));
    expect(await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', requestId)).toHaveLength(1);
  });

  it('SC-005 알림 생성이 실패해도 업무는 성공하고, 알림 행은 하나도 남지 않는다', async () => {
    const emitter = app.get(NotificationEmitter);
    // 시험 스위치 — 담당자 판정에서 실패를 주입한다.
    jest.spyOn(emitter as unknown as { decideHandover: () => Promise<never> }, 'decideHandover').mockRejectedValue(new Error('주입'));

    const requestId = await createShipmentRequest(ids.plant1);
    expect(await prisma.shipment_request.count({ where: { shipment_request_id: requestId } })).toBe(1);
    expect(await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', requestId)).toHaveLength(0);
  });

  it('FR-003 업무 트랜잭션이 롤백되면 알림도 없다', async () => {
    const requestId = await createShipmentRequest(null);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.shipment_request.update({ where: { shipment_request_id: requestId }, data: { fulfillment_plant_id: ids.plant1 } });
        await app.get(LogisticsHandoverNotifier).shipmentPicking(tx, requestId);
        expect(await tx.notification_event.count({ where: { aggregate_type_code: 'SHIPMENT_REQUEST', aggregate_id: requestId } })).toBe(1);
        throw new Error('업무 실패');
      }),
    ).rejects.toThrow('업무 실패');
    expect(await eventsOf('SHIPMENT_PICKING_REQUESTED', 'SHIPMENT_REQUEST', requestId)).toHaveLength(0);
  });

  async function eventsOf(type: string, aggregate: string, id: bigint) {
    return prisma.notification_event.findMany({
      where: { event_type_code: type, aggregate_type_code: aggregate, aggregate_id: id },
    });
  }

  async function configure(plantId: bigint, type: string, recipients: bigint[], zalo: boolean): Promise<void> {
    const detail = await request(app.getHttpServer())
      .get(`/api/app/handover-alert-settings/${plantId}/${type}`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .put(`/api/app/handover-alert-settings/${plantId}/${type}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag)
      .send({ enabled: true, zaloEnabled: zalo, recipientUserIds: recipients.map(Number) })
      .expect(200);
  }

  async function receiveLot(warehouseId: bigint, locationId: bigint, itemId: bigint, plantId: bigint): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${randomUUID().slice(0, 8)}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    await postReceipt(warehouseId, locationId, itemId, plantId, lot.lot_id);
    return lot.lot_id;
  }

  async function receive(warehouseId: bigint, locationId: bigint, itemId: bigint, plantId: bigint): Promise<bigint> {
    const lot = await receiveLot(warehouseId, locationId, itemId, plantId);
    const line = await prisma.goods_receipt_line.findFirstOrThrow({ where: { lot_id: lot }, select: { goods_receipt_id: true } });
    return line.goods_receipt_id;
  }

  async function postReceipt(warehouseId: bigint, locationId: bigint, itemId: bigint, plantId: bigint, lotId: bigint) {
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId: Number(plantId),
        warehouseId: Number(warehouseId),
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId: Number(itemId),
            lotId: Number(lotId),
            receiptQty: 10,
            uomId: Number(ids.uom),
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: Number(locationId),
          },
        ],
      })
      .expect(201);
  }

  async function createShipmentRequest(plantId: bigint | null): Promise<bigint> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/shipment-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        customerId: Number(ids.customer),
        shipToPartnerId: Number(ids.customer),
        requestedShipDate: '2026-10-30',
        ...(plantId === null ? {} : { fulfillmentPlantId: Number(plantId) }),
        lines: [{ itemId: Number(ids.itemA), requestedQty: 5, allocatedQty: 5, uomId: Number(ids.uom), shippingInspectionRequired: false }],
      })
      .expect(201);
    const id = BigInt(response.body.shipmentRequestId);
    created.requests.push(id);
    return id;
  }

  async function assignPlant(requestId: bigint, plantId: bigint, version: string): Promise<void> {
    await request(app.getHttpServer())
      .put(`/api/logistics/shipment-requests/${requestId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', version)
      .send({ fulfillmentPlantId: Number(plantId) })
      .expect(200);
  }

  function userCookie(appUserId: bigint): string {
    return `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(appUserId), typ: 'session' })}`;
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const unit = await prisma.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    ids.businessUnit = unit.business_unit_id;
    for (const key of ['plant1', 'plant2'] as const) {
      // 공장은 고정 코드로 다시 쓴다 — 원장이 붙어 지울 수 없어, 실행마다 새로 만들면 공장 목록(mdm-reference 등)의 쪽을 밀어낸다.
      const code = `${ROOT}${key}`;
      ids[key] = (
        (await prisma.plant.findFirst({ where: { plant_code: code } })) ??
        await prisma.plant.create({
          data: {
            plant_code: code,
            plant_name: `${ROOT} ${key}`,
            legal_entity_id: base.legal_entity_id,
            business_unit_id: unit.business_unit_id,
            timezone_code: 'Asia/Ho_Chi_Minh',
          },
        })
      ).plant_id;
    }
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    for (const key of ['itemA', 'itemB'] as const) {
      ids[key] = (
        await prisma.item.create({
          data: { item_code: `${PREFIX}-${key}`, item_name: `${PREFIX} ${key}`, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
        })
      ).item_id;
    }
    for (const [wh, loc, plant, name] of [
      ['whA', 'locA', ids.plant1, 'A'],
      ['whB', 'locB', ids.plant1, 'B'],
      ['whC', 'locC', ids.plant2, 'C'],
    ] as const) {
      const warehouse = await prisma.warehouse.create({
        data: {
          plant_id: plant,
          business_unit_id: unit.business_unit_id,
          warehouse_code: `${PREFIX}-${name}`,
          warehouse_name: `${PREFIX} 창고${name}`,
          warehouse_type_code: 'MATERIAL',
          management_level_code: 'LOCATION',
        },
      });
      ids[wh] = warehouse.warehouse_id;
      ids[loc] = (
        await prisma.location.create({
          data: { warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-L${name}`, location_name: `${PREFIX} 위치${name}`, location_type_code: 'BIN' },
        })
      ).location_id;
    }

    const finished = await prisma.item.create({
      data: { item_code: `${PREFIX}-FG`, item_name: `${PREFIX} 완제품`, item_type_code: 'FINISHED_GOODS', base_uom_id: ids.uom, lot_controlled: true },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: finished.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: finished.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: ids.uom,
      },
    });
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant1,
        item_id: finished.item_id,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
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
    });
    ids.workOrder = (
      await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-WO`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: finished.item_id,
          order_qty: 100,
          uom_id: ids.uom,
          status_code: 'RELEASED',
          default_wip_location_id: ids.locA,
        },
      })
    ).work_order_id;
    ids.customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-C`, partner_name: `${PREFIX} 고객` } })).partner_id;
    await prisma.worker.create({ data: { worker_no: WORKER_NO, worker_name: `${PREFIX} 작업자`, plant_id: ids.plant1, business_unit_id: ids.businessUnit, status_code: 'EMPLOYED' } });

    for (const [key, phone] of [['ADMIN', null], ['U1', '84912340001'], ['U2', null]] as const) {
      users[key] = (
        await prisma.app_user.create({
          data: { login_id: `${PREFIX}_${key}`, user_name: `${PREFIX} ${key}`, status_code: 'EMPLOYED', phone_number: phone },
        })
      ).app_user_id;
    }
    for (const plant of [ids.plant1, ids.plant2]) {
      await prisma.user_data_scope.create({ data: { app_user_id: users.ADMIN, business_unit_id: unit.business_unit_id, plant_id: plant } });
    }
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '인계 물류 시험' } });
    roleIds.push(role.role_id);
    await prisma.role_permission.createMany({
      data: ['W-CO-14', 'M-04-04', 'W-02-10', 'M-01-10', 'W-04-01', 'W-04-04', 'W-04-05'].map((code) => ({ role_id: role.role_id, permission_code: code })),
    });
    await prisma.user_role.create({ data: { app_user_id: users.ADMIN, role_id: role.role_id } });
    cookie = userCookie(users.ADMIN);
  }

  async function cleanup(): Promise<void> {
    const userIds = Object.values(users);
    const plants = [ids.plant1, ids.plant2].filter((id) => id !== 0n);
    const events = await prisma.notification_event.findMany({
      where: {
        OR: [
          { notification: { some: { recipient_user_id: { in: userIds } } } },
          { aggregate_type_code: 'SHIPMENT_REQUEST', aggregate_id: { in: created.requests } },
        ],
      },
      select: { notification_event_id: true },
    });
    const eventIds = events.map((e) => e.notification_event_id);
    await prisma.zalo_delivery.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    await prisma.notification_event.deleteMany({ where: { notification_event_id: { in: eventIds } } });
    const settings = await prisma.handover_alert_setting.findMany({ where: { plant_id: { in: plants } }, select: { handover_alert_setting_id: true } });
    await prisma.handover_alert_recipient.deleteMany({ where: { handover_alert_setting_id: { in: settings.map((s) => s.handover_alert_setting_id) } } });
    await prisma.handover_alert_setting.deleteMany({ where: { plant_id: { in: plants } } });
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
   * 전표는 지운다 — 전역 목록을 단언하는 스위트(재고 이동 등)에 끼어든다. 이전 실행의 찌꺼기까지 접두어 뿌리로 짚는다.
   * ⛔ 원장은 트리거가 행 삭제를 막아 남기고, 원장이 FK 로 붙잡는 마스터(창고·품목·LOT)도 남긴다.
   */
  async function deleteDocuments(): Promise<void> {
    const wh = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${ROOT}%' AND warehouse_type_code = 'MATERIAL'`;
    const requests = `SELECT r.shipment_request_id FROM logistics.shipment_request r
      WHERE r.customer_id IN (SELECT partner_id FROM mdm.partner WHERE partner_code LIKE '${ROOT}%')
        AND NOT EXISTS (SELECT 1 FROM logistics.shipment s WHERE s.shipment_request_id = r.shipment_request_id AND s.shipment_no NOT LIKE '${ROOT}%')`;
    const sql = [
      `DELETE FROM logistics.stock_transfer_line WHERE stock_transfer_id IN (SELECT stock_transfer_id FROM logistics.stock_transfer WHERE from_warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.stock_transfer WHERE from_warehouse_id IN (${wh})`,
      `DELETE FROM logistics.picking_line WHERE picking_order_id IN (SELECT picking_order_id FROM logistics.picking_order WHERE warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.picking_order WHERE warehouse_id IN (${wh})`,
      `DELETE FROM logistics.material_issue_request_line WHERE material_issue_request_id IN (SELECT material_issue_request_id FROM logistics.material_issue_request r JOIN production.work_order w USING (work_order_id) WHERE w.work_order_no LIKE '${ROOT}%')`,
      `DELETE FROM logistics.material_issue_request WHERE work_order_id IN (SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${ROOT}%')`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${ROOT}%'`,
      // 실제 출하(원장)가 붙은 지시는 남긴다 — 원장이 삭제를 막는다. 이 지시들은 공장이 정해져 전역 집계에 끼지 않는다.
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_id IN (${requests})`,
      `DELETE FROM logistics.putaway_task WHERE goods_receipt_line_id IN (SELECT goods_receipt_line_id FROM logistics.goods_receipt_line l JOIN logistics.goods_receipt g USING (goods_receipt_id) WHERE g.warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE warehouse_id IN (${wh}))`,
      `DELETE FROM logistics.goods_receipt WHERE warehouse_id IN (${wh})`,
    ];
    for (const statement of sql) await prisma.$executeRawUnsafe(statement);
  }
});
