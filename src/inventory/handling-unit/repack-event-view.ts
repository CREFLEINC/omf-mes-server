import { Prisma } from '@prisma/client';

/**
 * 계약 `HandlingUnitRepackEvent`(헤더 5칸) + `HandlingUnitRepackEventLine`(라인 6칸) 으로
 * 옮기는 자리 — 원천은 I-16 이 신설한 `inventory.handling_unit_repack_event(+_line)` 이다.
 *
 * ⛔ 라인의 `uom_id_before`·`uom_id_after` 는 «싣지 않는다» — 계약 라인 6칸에 그 자리가
 * 없다(통보 165). 서버가 채우고 서버만 읽는 칸이다. 계약에 `uomId` 가 서면 그때 싣는다.
 * ⛔ `line_no`·`created_at` 도 계약에 없다 — 정렬 축일 뿐이다.
 */

/** 라인 순서는 `line_no asc` 다 — 정렬을 안 주면 Prisma 가 순서를 약속하지 않는다. */
export const REPACK_EVENT_INCLUDE = {
  lines: { orderBy: { line_no: 'asc' } },
} as const satisfies Prisma.handling_unit_repack_eventInclude;

export type RepackEventRow = Prisma.handling_unit_repack_eventGetPayload<{
  include: typeof REPACK_EVENT_INCLUDE;
}>;
type RepackEventLineRow = RepackEventRow['lines'][number];

export interface HandlingUnitRepackEventLineView {
  handlingUnitId: number;
  roleCode: string;
  itemId: number;
  lotId: number;
  qtyBefore: number;
  qtyAfter: number;
}

export interface HandlingUnitRepackEventView {
  repackEventId: number;
  repackTypeCode: string;
  performedBy: number;
  occurredAt: string;
  lines: HandlingUnitRepackEventLineView[];
}

export function repackEventView(row: RepackEventRow): HandlingUnitRepackEventView {
  return {
    repackEventId: Number(row.handling_unit_repack_event_id),
    repackTypeCode: row.repack_type_code,
    performedBy: Number(row.performed_by),
    occurredAt: row.occurred_at.toISOString(),
    lines: row.lines.map(repackEventLineView),
  };
}

function repackEventLineView(line: RepackEventLineRow): HandlingUnitRepackEventLineView {
  return {
    handlingUnitId: Number(line.handling_unit_id),
    roleCode: line.role_code,
    itemId: Number(line.item_id),
    lotId: Number(line.lot_id),
    qtyBefore: Number(line.qty_before),
    qtyAfter: Number(line.qty_after),
  };
}
