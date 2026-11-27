import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `MaterialReturn`·`MaterialReturnLine` 으로 옮기는 자리 — 목록·상세·등록 응답이 같은 모양이다.
 *
 * - 옛 「반출 요청」 행은 머리에 W/O·출발 위치가 있고 줄에 귀속 칸이 없다. 반납 입고(피처 019) 행은 그 반대다.
 *   없는 칸은 키째 뺀다 — 단, 귀속 칸이 있는 줄의 `workOrderId`·`workOrderNo` 는 귀속 없음이면 `null` 로 낸다.
 * ⛔ `returnQualityStatusCode`·`packageOpened`·`qualityCheckRequired`·`inventoryTransactionLineId` 는 응답 스키마에 칸이 없다.
 * ⛔ `labelUnprinted` 는 등록 응답에만 싣는다 — 호출자가 줄마다 넘긴다.
 */
export const MATERIAL_RETURN_LINE_INCLUDE = {
  material_return_line: {
    orderBy: { line_no: 'asc' },
    include: {
      lot: { select: { lot_no: true } },
      work_order: { select: { work_order_no: true } },
      location: { select: { location_code: true, warehouse_id: true } },
    },
  },
} as const;

export type MaterialReturnRow = Prisma.material_returnGetPayload<{
  include: typeof MATERIAL_RETURN_LINE_INCLUDE;
}>;
export type MaterialReturnLineRow = MaterialReturnRow['material_return_line'][number];
export type MaterialReturnView = ReturnType<typeof materialReturnView>;
export type MaterialReturnLineView = ReturnType<typeof materialReturnLineView>;

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));

export function materialReturnView(row: MaterialReturnRow, unprintedLotIds?: ReadonlySet<bigint>) {
  return omitEmpty({
    materialReturnId: Number(row.material_return_id),
    materialReturnNo: row.material_return_no,
    workOrderId: id(row.work_order_id),
    sourceLocationId: id(row.source_location_id),
    destinationWarehouseId: Number(row.destination_warehouse_id),
    // `x-no-code-key` — 값 목록이 없다. 저장된 문자를 그대로 낸다.
    statusCode: row.status_code,
    terminalKindCode: row.terminal_kind_code ?? undefined,
    businessDate: row.business_date === null ? undefined : row.business_date.toISOString().slice(0, 10),
    requestedAt: row.requested_at.toISOString(),
    receivedAt: row.received_at === null ? undefined : row.received_at.toISOString(),
    lines: row.material_return_line.map((line) => materialReturnLineView(line, unprintedLotIds)),
  });
}

export function materialReturnLineView(row: MaterialReturnLineRow, unprintedLotIds?: ReadonlySet<bigint>) {
  const attributed = row.attribution_code !== null;
  return omitEmpty({
    materialReturnLineId: Number(row.material_return_line_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    returnQty: Number(row.return_qty),
    uomId: Number(row.uom_id),
    workOrderId: attributed ? (id(row.work_order_id) ?? null) : undefined,
    workOrderNo: attributed ? (row.work_order?.work_order_no ?? null) : undefined,
    goodsIssueLineId: id(row.goods_issue_line_id),
    attributionCode: row.attribution_code ?? undefined,
    destinationLocationId: id(row.destination_location_id),
    destinationLocationCode: row.location?.location_code,
    destinationWarehouseId: row.location === null ? undefined : Number(row.location.warehouse_id),
    labelUnprinted: unprintedLotIds === undefined ? undefined : unprintedLotIds.has(row.lot_id),
  });
}
