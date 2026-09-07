import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 목록 한 행에 필요한 의뢰 조인 4칸 + 파생(`lotNo`·`processId`·`processName`)을 한 쿼리로
 * 묶는다(N+1 금지 · §4-4). `select` 로 좁힌다 — 이 뷰가 안 쓰는 칸을 끌고 오지 않는다.
 * `processId` 두 갈래(§2-3): ⓑ W/O 축(`work_order.routing_operation.process_id` · 2단)을
 * 먼저 보고 비면 ⓐ 기준 축(3단)으로 떨어진다 — 계약 「2단」과 홉 수가 맞는 쪽이 ⓑ 다(문의 069+5).
 */
export const INSPECTION_RESULT_JOIN = {
  inspection_request: {
    select: {
      inspection_request_no: true,
      inspection_type_code: true,
      item_id: true,
      lot_id: true,
      lot: { select: { lot_no: true } },
      work_order: { select: { routing_operation: { select: { process: { select: { process_id: true, process_name: true } } } } } },
      inspection_plan_version: {
        select: { inspection_plan: { select: { process: { select: { process_id: true, process_name: true } } } } },
      },
    },
  },
} satisfies Prisma.inspection_resultInclude;

export type InspectionResultRow = Prisma.inspection_resultGetPayload<{ include: typeof INSPECTION_RESULT_JOIN }>;

export type InspectionResultView = ReturnType<typeof inspectionResultView>;

export function inspectionResultView(row: InspectionResultRow) {
  const request = row.inspection_request;
  const process =
    request.work_order?.routing_operation.process ?? request.inspection_plan_version?.inspection_plan.process ?? null;

  return omitEmpty({
    inspectionResultId: Number(row.inspection_result_id),
    inspectionResultNo: row.inspection_result_no,
    inspectionRequestId: Number(row.inspection_request_id),
    inspectionRequestNo: request.inspection_request_no,
    inspectionTypeCode: request.inspection_type_code,
    itemId: Number(request.item_id),
    lotId: request.lot_id === null ? undefined : Number(request.lot_id),
    inspectionRound: row.inspection_round,
    inspectedQty: Number(row.inspected_qty),
    acceptedQty: Number(row.accepted_qty),
    rejectedQty: Number(row.rejected_qty),
    heldQty: Number(row.held_qty),
    uomId: Number(row.uom_id),
    // ⭐ DRAFT + 판정 없음(M-e ⓒ) — 계약은 이 칸을 required·type:"string"(널 없음)으로 닫았다.
    // 키 생략은 required 위반, 값을 지어내면 F-6 위반이라 있는 그대로(null)를 낸다 — 계약이
    // 못 그리는 자리다(문의 069+16 · README §2 2단계 기준 3·4: nullable 의 뜻으로 두되 안 짓는다).
    overallJudgmentCode: row.overall_judgment_code,
    inspectorId: Number(row.inspector_id),
    inspectedAt: row.inspected_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString(),
    terminalId: row.terminal_id === null ? undefined : Number(row.terminal_id),
    statusCode: row.status_code,
    previousResultId: row.previous_result_id === null ? undefined : Number(row.previous_result_id),
    reinspectionReasonCode: row.reinspection_reason_code ?? undefined,
    remarks: row.remarks ?? undefined,
    versionNo: row.version_no,
    // ⭐ 계약 `[type,null]` 파생 3칸 — §5-7 기본(값 없으면 키 생략, 널 금지)을 따른다. 같은
    // 슬라이스의 `inspection-request-view.ts` 도 같은 선택 — 저장소 선례가 갈린 자리(#294 M-1)다.
    lotNo: request.lot?.lot_no ?? undefined,
    processId: process === null ? undefined : Number(process.process_id),
    processName: process?.process_name ?? undefined,
  });
}
