import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `OperationHandover`(8칸 · required 6)·`OperationHandoverLine`(4칸 · required 3)로
 * 옮기는 자리(I-25 §1-4).
 *
 * ⛔ 라인은 계약에 «있는 4칸만» 낸다 — `lineNo`·`receivedQty`·`sourceLocationId`·
 *    `destinationLocationId` 는 응답 스키마에 칸이 «없다»(§1-4 · R-10). 헤더도 `versionNo`·
 *    감사 4칸을 안 낸다(ajv 가 못 잡는 자리 — §7-1 ⓐ).
 */
export const OPERATION_HANDOVER_LINE_INCLUDE = {
  operation_handover_line: { orderBy: { line_no: 'asc' } },
} as const;

export type OperationHandoverRow = Prisma.operation_handoverGetPayload<{
  include: typeof OPERATION_HANDOVER_LINE_INCLUDE;
}>;
export type OperationHandoverLineRow = Prisma.operation_handover_lineGetPayload<object>;
export type OperationHandoverView = ReturnType<typeof operationHandoverView>;
export type OperationHandoverLineView = ReturnType<typeof operationHandoverLineView>;

/**
 * 목록도 상세도 이 하나로 낸다 — 목록·상세가 같은 `OperationHandover` 스키마라 비우면
 * 자리마다 모양이 갈린다(`material-return-view.ts` 와 같은 근거 · I-25 §3-1).
 */
export function operationHandoverView(row: OperationHandoverRow) {
  return omitEmpty({
    operationHandoverId: Number(row.operation_handover_id),
    handoverNo: row.handover_no,
    fromWorkOrderId: Number(row.from_work_order_id),
    toWorkOrderId: Number(row.to_work_order_id),
    // `x-no-code-key` — 값 목록이 없다. 저장된 문자를 그대로 낸다.
    statusCode: row.status_code,
    handedOverAt: row.handed_over_at.toISOString(),
    receivedAt: row.received_at === null ? undefined : row.received_at.toISOString(),
    lines: row.operation_handover_line.map(operationHandoverLineView),
  });
}

/** ⚠ `lotId` ← `source_lot_id` — 계약 칸 이름과 물리 칸 이름이 다르다(§1-4 · §7-1 ⓑ). */
export function operationHandoverLineView(row: OperationHandoverLineRow) {
  return {
    operationHandoverLineId: Number(row.operation_handover_line_id),
    lotId: Number(row.source_lot_id),
    handoverQty: Number(row.handover_qty),
    uomId: Number(row.uom_id),
  };
}
