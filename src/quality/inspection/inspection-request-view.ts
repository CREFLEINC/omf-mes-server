import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/** 계약 `InspectionRequest`(17칸) 매퍼 — 결손 0, 물리와 1:1(§2-1). */
export type InspectionRequestRow = Prisma.inspection_requestGetPayload<object>;

export type InspectionRequestView = ReturnType<typeof inspectionRequestView>;

export function inspectionRequestView(row: InspectionRequestRow) {
  return omitEmpty({
    inspectionRequestId: Number(row.inspection_request_id),
    inspectionRequestNo: row.inspection_request_no,
    inspectionTypeCode: row.inspection_type_code,
    // ⚠ 물리는 아직 NOT NULL 이다(M-e 전) — 계약은 `[integer,null]` 이라 null 갈래를 이미
    // 갖지만 지금은 값이 없는 행이 없다. M-e(PR ③)가 나가면 이 칸도 null 분기가 필요하다.
    inspectionPlanVersionId: Number(row.inspection_plan_version_id),
    targetTypeCode: row.target_type_code,
    targetId: Number(row.target_id),
    itemId: Number(row.item_id),
    lotId: row.lot_id === null ? undefined : Number(row.lot_id),
    workOrderId: row.work_order_id === null ? undefined : Number(row.work_order_id),
    productionResultId: row.production_result_id === null ? undefined : Number(row.production_result_id),
    targetQty: Number(row.target_qty),
    uomId: Number(row.uom_id),
    coverageFromAt: row.coverage_from_at?.toISOString(),
    coverageToAt: row.coverage_to_at?.toISOString(),
    statusCode: row.status_code,
    requestedAt: row.requested_at.toISOString(),
    versionNo: row.version_no,
  });
}
