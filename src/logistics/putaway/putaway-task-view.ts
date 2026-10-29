import { Prisma } from '@prisma/client';

import { AllowedLocation } from './allowed-locations';

/**
 * 계약 `PutawayTask` 로 옮기는 자리 — 필수 12 · 프로퍼티 16. `inventoryTransactionLineId`·
 * `reasonCode`·`versionNo` 는 물리에 있어도 응답 스키마에 없다(문의 059+2) — 안 싣는다.
 */
export const TASK_INCLUDE = {
  goods_receipt_line: {
    select: {
      goods_receipt: {
        select: { warehouse_id: true },
      },
    },
  },
} as const;

export type TaskRow = Prisma.putaway_taskGetPayload<{ include: typeof TASK_INCLUDE }>;

export interface PutawayTaskView {
  putawayTaskId: number; putawayTaskNo: string; goodsReceiptLineId: number;
  itemId: number; lotId: number; taskQty: number; uomId: number; fromLocationId: number;
  allowedLocations: AllowedLocation[]; actualLocationId: number | null;
  /** 원천은 `goods_receipt.warehouse_id` 다 — `fromLocationId`(하역장)는 다른 창고일 수 있다. */
  warehouseId: number;
  priorityNo: number; assignedWorkerId: number | null;
  statusCode: string; completedAt: string | null; remarks: string | null;
}

export function taskView(row: TaskRow, allowedLocations: AllowedLocation[]): PutawayTaskView {
  return {
    putawayTaskId: Number(row.putaway_task_id),
    putawayTaskNo: row.putaway_task_no,
    goodsReceiptLineId: Number(row.goods_receipt_line_id),
    itemId: Number(row.item_id), lotId: Number(row.lot_id),
    taskQty: Number(row.task_qty), uomId: Number(row.uom_id),
    fromLocationId: Number(row.from_location_id),
    allowedLocations, actualLocationId: id(row.actual_location_id),
    warehouseId: Number(row.goods_receipt_line.goods_receipt.warehouse_id),
    priorityNo: row.priority_no, assignedWorkerId: id(row.assigned_worker_id),
    statusCode: row.status_code,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    remarks: row.remarks,
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
