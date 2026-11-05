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
    warehouseId: Number(taskWarehouseId(row)),
    priorityNo: row.priority_no, assignedWorkerId: id(row.assigned_worker_id),
    statusCode: row.status_code,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    remarks: row.remarks,
  };
}

/**
 * 적치 창고 = 원천 입고의 창고. 칸은 NULL 을 허용하지만(피처 004 보충 수령 원천) 그 지시를 만드는 경로가
 * 아직 없다 — 입고 줄 없는 지시를 만나면 조용히 틀린 창고를 내지 않고 멈춘다.
 */
export function taskWarehouseId(row: TaskRow): bigint {
  if (row.goods_receipt_line === null) throw new Error(`입고 줄이 없는 적치 지시다: ${row.putaway_task_id}`);
  return row.goods_receipt_line.goods_receipt.warehouse_id;
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
