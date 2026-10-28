import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter, formatEventTime } from '../notification';
import { WrittenPicking } from './picking-generation';

/**
 * T2 자재 출고 피킹 — 피킹 지시마다 한 건(omf-all-around#190 · research R-3). 공장 = 피킹 창고의 공장.
 * 출고요청이 생기는 두 자리(W/O 배포 · 추가 출고 요청)가 함께 부른다 — `writePicking` 과 같은 이유로 코어에 둔다.
 */
@Injectable()
export class PickingHandoverNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  async notify(
    tx: Prisma.TransactionClient,
    pickings: readonly WrittenPicking[],
    source: { workOrderId: bigint; requiredAt: Date | null },
  ): Promise<void> {
    if (pickings.length === 0) return;
    const [workOrder, warehouses, orders] = await Promise.all([
      tx.work_order.findUnique({ where: { work_order_id: source.workOrderId }, select: { work_order_no: true } }),
      tx.warehouse.findMany({
        where: { warehouse_id: { in: pickings.map((p) => p.warehouseId) } },
        select: { warehouse_id: true, warehouse_name: true, plant_id: true },
      }),
      tx.picking_order.findMany({
        where: { picking_order_id: { in: pickings.map((p) => p.pickingOrderId) } },
        select: { picking_order_id: true, picking_order_no: true },
      }),
    ]);
    const warehouseOf = new Map(warehouses.map((w) => [w.warehouse_id, w]));
    const noOf = new Map(orders.map((o) => [o.picking_order_id, o.picking_order_no]));
    const occurredAt = new Date();
    for (const picking of pickings) {
      const warehouse = warehouseOf.get(picking.warehouseId);
      if (warehouse === undefined) continue;
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'MATERIAL_PICKING_REQUESTED',
        plantId: warehouse.plant_id,
        aggregateTypeCode: 'PICKING_ORDER',
        aggregateId: picking.pickingOrderId,
        occurredAt,
        values: {
          picking_no: noOf.get(picking.pickingOrderId),
          wo_no: workOrder?.work_order_no,
          item_count: picking.lineCount,
          warehouse: warehouse.warehouse_name,
          required_at: source.requiredAt === null ? null : formatEventTime(source.requiredAt),
        },
      });
    }
  }
}
