import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `MaterialReturn`(8칸 · required 7)·`MaterialReturnLine`(5칸 · required 4)로 옮기는 자리.
 *
 * ⛔ 라인은 계약에 **있는 5칸만** 낸다 — `lineNo`·`returnQualityStatusCode`·`packageOpened`·
 *    `qualityCheckRequired`·`inventoryTransactionLineId` 는 응답 스키마에 칸이 «없다»(I-10 §1-4).
 * ⛔ `item`·`lot` 을 조인하지 않는다 — 라인에 표시 라벨 칸이 0개다.
 */
export const MATERIAL_RETURN_LINE_INCLUDE = {
  material_return_line: { orderBy: { line_no: 'asc' } },
} as const;

export type MaterialReturnRow = Prisma.material_returnGetPayload<{
  include: typeof MATERIAL_RETURN_LINE_INCLUDE;
}>;
export type MaterialReturnLineRow = Prisma.material_return_lineGetPayload<object>;
export type MaterialReturnView = ReturnType<typeof materialReturnView>;
export type MaterialReturnLineView = ReturnType<typeof materialReturnLineView>;

/**
 * 목록도 상세도 이 하나로 낸다 — 목록·상세가 같은 `MaterialReturn` 스키마라 비우면 자리마다
 * 모양이 갈린다(I-10 §5-3).
 */
export function materialReturnView(row: MaterialReturnRow) {
  return omitEmpty({
    materialReturnId: Number(row.material_return_id),
    materialReturnNo: row.material_return_no,
    workOrderId: Number(row.work_order_id),
    sourceLocationId: Number(row.source_location_id),
    destinationWarehouseId: Number(row.destination_warehouse_id),
    // `x-no-code-key` — 값 목록이 없다. 저장된 문자를 그대로 낸다.
    statusCode: row.status_code,
    requestedAt: row.requested_at.toISOString(),
    receivedAt: row.received_at === null ? undefined : row.received_at.toISOString(),
    lines: row.material_return_line.map(materialReturnLineView),
  });
}

export function materialReturnLineView(row: MaterialReturnLineRow) {
  return {
    materialReturnLineId: Number(row.material_return_line_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    returnQty: Number(row.return_qty),
    uomId: Number(row.uom_id),
  };
}
