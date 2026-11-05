import { Prisma } from '@prisma/client';

import { LineDerived, RequestDerived } from './material-issue-request-derived';

/**
 * 계약 `MaterialIssueRequest`·`MaterialIssueRequestLine` 으로 옮기는 자리 —
 * `x-source-column` 1:1 이고 라벨 칸(`itemCode`·`workOrderNo`)을 지어 넣지 않는다(문의 047).
 * ⛔ 널이어도 **키를 생략하지 않는다** — 그 다섯 칸은 계약 `type` 에 `null` 이 이미 있다
 * (선례 `goods-issue-view.ts:77` · I-8.md R-20).
 * ⛔ 칸을 인터페이스로 한 벌 더 적지 않는다 — 매퍼가 정본이다(`work-order-view.ts` 관행).
 */

export type MaterialIssueRequestView = ReturnType<typeof materialIssueRequestView>;
export type MaterialIssueRequestLineView = ReturnType<typeof materialIssueRequestLineView>;

export interface MaterialIssueRequestDetail {
  materialIssueRequest: MaterialIssueRequestView;
  lines: MaterialIssueRequestLineView[];
}

export function materialIssueRequestView(row: Prisma.material_issue_requestGetPayload<object>, derived?: RequestDerived) {
  return {
    materialIssueRequestId: Number(row.material_issue_request_id),
    issueRequestNo: row.issue_request_no,
    // 창고 보충 요청(피처 004)은 W/O 가 없다 — null.
    workOrderId: id(row.work_order_id),
    destinationLocationId: Number(row.destination_location_id),
    requiredAt: row.required_at === null ? null : row.required_at.toISOString(),
    statusCode: row.status_code,
    requestedBy: id(row.requested_by),
    reasonCode: row.reason_code,
    remarks: row.remarks,
    // 계획 기반 출고 요청(피처 003) — 이 기능 전 요청·생산 창고 없는 공장의 요청은 모두 null 이다.
    sourceWarehouseId: id(row.source_warehouse_id ?? null),
    issueWorkDate: row.issue_work_date?.toISOString().slice(0, 10) ?? null,
    releasedAt: row.released_at?.toISOString() ?? null,
    releaseErrorText: row.release_error_text ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    closeReasonCode: row.close_reason_code ?? null,
    // 창고 보충(피처 004) — W/O 요청은 requestTypeCode 만 WORK_ORDER 이고 나머지는 null 이다.
    requestTypeCode: row.request_type_code,
    replenishmentOriginCode: row.replenishment_origin_code ?? null,
    closeReasonDetailCode: row.close_reason_detail_code ?? null,
    closeRemark: row.close_remark ?? null,
    closedBy: id(row.closed_by ?? null),
    // 수정·취소의 저장 충돌 보호 — 본문 versionNo 로 되돌려 보낸다(W-02-11).
    versionNo: row.version_no,
    // 화면 값(파생 · W-02-11) — 목록·상세·발행·수정·취소 응답이 싣는다(조회 서비스를 거친다).
    ...(derived === undefined
      ? {}
      : {
          displayStatus: derived.displayStatus,
          sourceWarehouseName: derived.sourceWarehouseName,
          workOrderNo: derived.workOrderNo,
          productionDate: derived.productionDate,
          productionPlanId: derived.productionPlanId,
          productionPlanNo: derived.productionPlanNo,
          destinationLocationName: derived.destinationLocationName,
          destinationWarehouseId: derived.destinationWarehouseId,
          destinationWarehouseName: derived.destinationWarehouseName,
          lineCount: derived.lineCount,
          shortageQtyTotal: derived.shortageQtyTotal,
          dynamicShortageQtyTotal: derived.dynamicShortageQtyTotal,
        }),
  };
}

export function materialIssueRequestLineView(
  row: Prisma.material_issue_request_lineGetPayload<object>,
  derived?: LineDerived,
) {
  return {
    materialIssueRequestLineId: Number(row.material_issue_request_line_id),
    materialIssueRequestId: Number(row.material_issue_request_id),
    lineNo: row.line_no,
    bomComponentId: id(row.bom_component_id),
    itemId: Number(row.item_id),
    requestedQty: Number(row.requested_qty),
    // 출고 전기가 올린다(P-16 · 문의 046 해소) — 피킹 라인이 요청 라인을 가리킬 때만이다.
    // `shortage` 의 기출고는 여전히 출고 전표 축으로 센다(축이 다르다 · `shortage.service.ts`).
    issuedQty: Number(row.issued_qty),
    uomId: Number(row.uom_id),
    // 만들 때 생산 창고의 쓸 수 있는 양에 걸려 줄인 양(피처 003). 소요 = requestedQty + shortageQty.
    shortageQty: Number(row.shortage_qty),
    ...(derived === undefined ? {} : derived),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
