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
  // 창고 보충 수령 원천(피처 004)은 입고 전표가 없다 — 창고는 출발 위치(적치 대기)의 창고다.
  location_putaway_task_from_location_idTolocation: { select: { warehouse_id: true } },
} as const;

export type TaskRow = Prisma.putaway_taskGetPayload<{ include: typeof TASK_INCLUDE }>;

export interface PutawayTaskView {
  putawayTaskId: number; putawayTaskNo: string;
  /** 창고 보충 수령 원천이면 null(피처 004) — 그때는 `shopfloorReceiptLineId` 가 있다. */
  goodsReceiptLineId: number | null; shopfloorReceiptLineId: number | null;
  originCode: 'GOODS_RECEIPT' | 'REPLENISHMENT_RECEIPT';
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
    goodsReceiptLineId: id(row.goods_receipt_line_id),
    shopfloorReceiptLineId: id(row.shopfloor_receipt_line_id),
    originCode: row.goods_receipt_line_id === null ? 'REPLENISHMENT_RECEIPT' : 'GOODS_RECEIPT',
    itemId: Number(row.item_id), lotId: Number(row.lot_id),
    taskQty: Number(row.task_qty), uomId: Number(row.uom_id),
    fromLocationId: Number(row.from_location_id),
    allowedLocations, actualLocationId: id(row.actual_location_id),
    warehouseId: Number(taskWarehouseId(row)),
    priorityNo: row.priority_no, assignedWorkerId: id(row.assigned_worker_id),
    statusCode: row.status_code,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    remarks: row.remarks,
  };
}

/**
 * 적치 창고 = 구매 입고 원천은 입고 전표의 창고(지금 그대로), 창고 보충 수령 원천은 출발 위치(적치 대기)의 창고.
 */
export function taskWarehouseId(row: TaskRow): bigint {
  if (row.goods_receipt_line !== null) return row.goods_receipt_line.goods_receipt.warehouse_id;
  return row.location_putaway_task_from_location_idTolocation.warehouse_id;
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
