import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, formatCalendarDate } from '../core/notification';
import { LogisticsWriteActor } from './logistics-write-actor';

type Tx = Prisma.TransactionClient;

/**
 * 물류 인계 작업 알림 — 값을 모아 생성기에 넘긴다(omf-all-around#190 · research R-3 T1·T3·T4·T5).
 * 업무 트랜잭션 «안»에서 부른다. 생성기가 SAVEPOINT 로 감싸 실패해도 업무는 이어 간다(SC-005).
 */
@Injectable()
export class LogisticsHandoverNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  /** T1 — 입고가 적치 지시를 만들었다(입고 1건에 1건). 공장 = 입고 공장. */
  async putaway(tx: Tx, goodsReceiptId: bigint, taskCount: number, actor: LogisticsWriteActor): Promise<void> {
    const receipt = await tx.goods_receipt.findUniqueOrThrow({
      where: { goods_receipt_id: goodsReceiptId },
      select: { goods_receipt_no: true, plant_id: true, warehouse: { select: { warehouse_name: true } } },
    });
    await this.emitter.emitHandover(tx, {
      alertTypeCode: 'PUTAWAY_REQUESTED',
      plantId: receipt.plant_id,
      aggregateTypeCode: 'GOODS_RECEIPT',
      aggregateId: goodsReceiptId,
      occurredAt: new Date(),
      values: {
        receipt_no: receipt.goods_receipt_no,
        warehouse: receipt.warehouse.warehouse_name,
        task_count: taskCount,
        actor: await actorName(tx, actor),
      },
    });
  }

  /** T3 — 창고 이동이 반출됐다. 공장 = «도착» 창고의 공장(확정 항목 6). */
  async stockTransferArrival(tx: Tx, stockTransferId: bigint, actor: LogisticsWriteActor): Promise<void> {
    const transfer = await tx.stock_transfer.findUniqueOrThrow({
      where: { stock_transfer_id: stockTransferId },
      select: {
        stock_transfer_no: true,
        warehouse_stock_transfer_from_warehouse_idTowarehouse: { select: { warehouse_name: true } },
        warehouse_stock_transfer_to_warehouse_idTowarehouse: { select: { warehouse_name: true, plant_id: true } },
        _count: { select: { stock_transfer_line: true } },
      },
    });
    const to = transfer.warehouse_stock_transfer_to_warehouse_idTowarehouse;
    await this.emitter.emitHandover(tx, {
      alertTypeCode: 'STOCK_TRANSFER_ARRIVAL_PENDING',
      plantId: to.plant_id,
      aggregateTypeCode: 'STOCK_TRANSFER',
      aggregateId: stockTransferId,
      // 반출 시각(단말이 보낸 값)이 아니라 지금이다 — 오프라인 재전송분이 Zalo 유효 24시간을 이미 넘겨 버리지 않게.
      occurredAt: new Date(),
      values: {
        transfer_no: transfer.stock_transfer_no,
        from_warehouse: transfer.warehouse_stock_transfer_from_warehouse_idTowarehouse.warehouse_name,
        to_warehouse: to.warehouse_name,
        item_count: transfer._count.stock_transfer_line,
        actor: await actorName(tx, actor),
      },
    });
  }

  /** T4 — 출하지시에 이행 공장이 있다(등록 때, 또는 처음 정해질 때). */
  async shipmentPicking(tx: Tx, shipmentRequestId: bigint): Promise<void> {
    const request = await tx.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: shipmentRequestId },
      select: {
        shipment_request_no: true,
        fulfillment_plant_id: true,
        requested_ship_date: true,
        partner_shipment_request_customer_idTopartner: { select: { partner_name: true } },
        _count: { select: { shipment_request_line: true } },
      },
    });
    if (request.fulfillment_plant_id === null) return;
    await this.emitter.emitHandover(tx, {
      alertTypeCode: 'SHIPMENT_PICKING_REQUESTED',
      plantId: request.fulfillment_plant_id,
      aggregateTypeCode: 'SHIPMENT_REQUEST',
      aggregateId: shipmentRequestId,
      occurredAt: new Date(),
      values: {
        request_no: request.shipment_request_no,
        customer: request.partner_shipment_request_customer_idTopartner.partner_name,
        item_count: request._count.shipment_request_line,
        ship_date: formatCalendarDate(request.requested_ship_date),
      },
    });
  }

  /** T5 — 출하가 생겼다(긴급 직행 포함). 공장 = 출하 창고의 공장. */
  async shipmentPacking(tx: Tx, shipmentId: bigint, appUserId: number): Promise<void> {
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { shipment_id: shipmentId },
      select: {
        shipment_no: true,
        warehouse: { select: { warehouse_name: true, plant_id: true } },
        shipment_request: { select: { requested_ship_date: true } },
      },
    });
    await this.emitter.emitHandover(tx, {
      alertTypeCode: 'SHIPMENT_PACKING_REQUESTED',
      plantId: shipment.warehouse.plant_id,
      aggregateTypeCode: 'SHIPMENT',
      aggregateId: shipmentId,
      occurredAt: new Date(),
      values: {
        shipment_no: shipment.shipment_no,
        warehouse: shipment.warehouse.warehouse_name,
        ship_date: formatCalendarDate(shipment.shipment_request.requested_ship_date),
        actor: await actorName(tx, { appUserId }),
      },
    });
  }
}

/** 처리자 — 계정이면 계정 이름, 단말 작성이면 사번 작업자 이름(단말 actor 에 계정이 없다 · research R-3). */
export async function actorName(tx: Tx, actor: LogisticsWriteActor): Promise<string | null> {
  if (actor.appUserId !== undefined) {
    const user = await tx.app_user.findUnique({ where: { app_user_id: actor.appUserId }, select: { user_name: true } });
    return user?.user_name ?? null;
  }
  const worker = await tx.worker.findUnique({ where: { worker_id: actor.workerId }, select: { worker_name: true } });
  return worker?.worker_name ?? null;
}
