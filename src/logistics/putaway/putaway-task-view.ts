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
  /** 원천 문서 번호 — 구매 입고면 입고 번호, 창고 보충 수령이면 창고 보충 요청 번호(모바일 「창고 보충 · 요청번호」). */
  originDocumentNo: string | null;
  itemId: number; lotId: number; taskQty: number; uomId: number; fromLocationId: number;
  allowedLocations: AllowedLocation[]; actualLocationId: number | null;
  /** 원천은 `goods_receipt.warehouse_id` 다 — `fromLocationId`(하역장)는 다른 창고일 수 있다. */
  warehouseId: number;
  priorityNo: number; assignedWorkerId: number | null;
  statusCode: string; completedAt: string | null; remarks: string | null;
}

export function taskView(row: TaskRow, allowedLocations: AllowedLocation[], originDocumentNo: string | null = null): PutawayTaskView {
  return {
    putawayTaskId: Number(row.putaway_task_id),
    putawayTaskNo: row.putaway_task_no,
    goodsReceiptLineId: id(row.goods_receipt_line_id),
    shopfloorReceiptLineId: id(row.shopfloor_receipt_line_id),
    originCode: row.goods_receipt_line_id === null ? 'REPLENISHMENT_RECEIPT' : 'GOODS_RECEIPT',
    originDocumentNo,
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

/**
 * 지시마다 원천 문서 번호 — 구매 입고 원천은 입고 번호, 창고 보충 수령 원천은 그 창고 보충 요청 번호(수령 줄 → 수령 → 출고 →
 * 피킹 지시 → 요청). 출고는 피킹을 원천 칸으로만 가리켜(FK 없음) 관계로 잇지 못한다. 한 쪽을 묶음 질의로 푼다.
 */
export async function originDocumentNos(
  db: Pick<Prisma.TransactionClient, 'goods_receipt_line' | 'shopfloor_receipt_line' | 'picking_order' | 'material_issue_request'>,
  rows: readonly Pick<TaskRow, 'putaway_task_id' | 'goods_receipt_line_id' | 'shopfloor_receipt_line_id'>[],
): Promise<Map<bigint, string>> {
  const result = new Map<bigint, string>();
  const receiptLineIds = rows.flatMap((row) => (row.goods_receipt_line_id == null ? [] : [row.goods_receipt_line_id]));
  if (receiptLineIds.length > 0) {
    const receiptLines = await db.goods_receipt_line.findMany({
      where: { goods_receipt_line_id: { in: receiptLineIds } },
      select: { goods_receipt_line_id: true, goods_receipt: { select: { goods_receipt_no: true } } },
    });
    const noOf = new Map(receiptLines.map((l) => [l.goods_receipt_line_id, l.goods_receipt.goods_receipt_no]));
    for (const row of rows) {
      const no = row.goods_receipt_line_id == null ? undefined : noOf.get(row.goods_receipt_line_id);
      if (no !== undefined) result.set(row.putaway_task_id, no);
    }
  }
  const lineIds = rows.flatMap((row) => (row.shopfloor_receipt_line_id == null ? [] : [row.shopfloor_receipt_line_id]));
  if (lineIds.length === 0) return result;
  const lines = await db.shopfloor_receipt_line.findMany({
    where: { shopfloor_receipt_line_id: { in: lineIds } },
    select: { shopfloor_receipt_line_id: true, shopfloor_receipt: { select: { goods_issue: { select: { source_document_type_code: true, source_document_id: true } } } } },
  });
  const pickingOf = new Map(
    lines
      .filter((l) => l.shopfloor_receipt.goods_issue.source_document_type_code === 'PICKING_ORDER')
      .map((l) => [l.shopfloor_receipt_line_id, l.shopfloor_receipt.goods_issue.source_document_id]),
  );
  const pickings = await db.picking_order.findMany({
    where: { picking_order_id: { in: [...new Set(pickingOf.values())] }, source_document_type_code: 'MATERIAL_ISSUE_REQUEST' },
    select: { picking_order_id: true, source_document_id: true },
  });
  const requestOf = new Map(pickings.map((p) => [p.picking_order_id, p.source_document_id]));
  const requests = await db.material_issue_request.findMany({
    where: { material_issue_request_id: { in: [...new Set(requestOf.values())] } },
    select: { material_issue_request_id: true, issue_request_no: true },
  });
  const noOf = new Map(requests.map((r) => [r.material_issue_request_id, r.issue_request_no]));
  for (const row of rows) {
    const picking = row.shopfloor_receipt_line_id == null ? undefined : pickingOf.get(row.shopfloor_receipt_line_id);
    const request = picking === undefined ? undefined : requestOf.get(picking);
    const no = request === undefined ? undefined : noOf.get(request);
    if (no !== undefined) result.set(row.putaway_task_id, no);
  }
  return result;
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
