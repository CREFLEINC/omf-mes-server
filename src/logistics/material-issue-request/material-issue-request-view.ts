import { Prisma } from '@prisma/client';

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

export function materialIssueRequestView(row: Prisma.material_issue_requestGetPayload<object>) {
  return {
    materialIssueRequestId: Number(row.material_issue_request_id),
    issueRequestNo: row.issue_request_no,
    workOrderId: Number(row.work_order_id),
    destinationLocationId: Number(row.destination_location_id),
    requiredAt: row.required_at === null ? null : row.required_at.toISOString(),
    statusCode: row.status_code,
    requestedBy: id(row.requested_by),
    reasonCode: row.reason_code,
    remarks: row.remarks,
  };
}

export function materialIssueRequestLineView(
  row: Prisma.material_issue_request_lineGetPayload<object>,
) {
  return {
    materialIssueRequestLineId: Number(row.material_issue_request_line_id),
    materialIssueRequestId: Number(row.material_issue_request_id),
    lineNo: row.line_no,
    bomComponentId: id(row.bom_component_id),
    itemId: Number(row.item_id),
    requestedQty: Number(row.requested_qty),
    // ⛔ 오늘 언제나 0 이다 — 이 칸을 올리는 오퍼레이션이 계약에 0건이다(문의 046).
    //    `shortage` 의 기출고는 이 칸이 아니라 출고 전표 축으로 센다.
    issuedQty: Number(row.issued_qty),
    uomId: Number(row.uom_id),
  };
}

function id(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
