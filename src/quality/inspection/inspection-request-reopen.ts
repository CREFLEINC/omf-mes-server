import { Tx } from '../../core/lot';
import { recordInspectionRequestEvent } from './inspection-request-event';
import { INBOUND_LOT_TARGET } from './iqc-inbound-lot-result';

const IQC = 'IQC';
const REQUESTED = 'REQUESTED';
const COMPLETED = 'COMPLETED';
const IN_PROGRESS = 'IN_PROGRESS';

/**
 * 끝난 검사 의뢰를 «진행»으로 되돌린다(`COMPLETED → IN_PROGRESS` · 장부 P-43 · 3단계 검증 2026-10-16 승인).
 *
 * ⭐ 계약은 의뢰 상태를 «이미 있는 액션의 부수 효과»로만 옮긴다 — 그중 「재검사 회차 추가가 다시
 *    `IN_PROGRESS`」를 여기서 한다. 서버 선행으로 「처분 재작업이 IQC 불합격 LOT 을 검사 대기로 되돌릴 때」도
 *    같은 전이를 탄다 — 끝난 의뢰는 판정 화면 대기 큐(`pendingOnly`)에 없어 재검사 회차를 쓸 길이 없었다.
 * ⚠ 전이표 «밖»이다 — `completeRequest`(확정 → `COMPLETED`)와 같은 자리(자기 스키마 직접 UPDATE)다.
 * ⛔ 끝난 의뢰만 옮긴다(조건부 UPDATE) — 이미 대기·진행이면 그대로다.
 */
export async function reopenInspectionRequestWithin(
  tx: Tx,
  inspectionRequestId: bigint,
  appUserId: number | undefined,
): Promise<void> {
  await tx.inspection_request.updateMany({
    where: { inspection_request_id: inspectionRequestId, status_code: COMPLETED },
    data: { status_code: IN_PROGRESS, updated_by: appUserId ?? null, version_no: { increment: 1 } },
  });
}

/**
 * 대기 의뢰를 «진행»으로 옮긴다(`REQUESTED → IN_PROGRESS` · omf-all-around#164) — 계약 「첫 임시 저장이 IN_PROGRESS」.
 * IQC·OQC·PQC 모두 작성중 회차를 이 저장 경로로 만든다. ⛔ 대기 의뢰만 옮긴다(조건부 UPDATE) — 이미 진행·끝난 의뢰는 그대로다.
 * ⛔ 되돌리는 전이(`IN_PROGRESS → REQUESTED`)는 없다 — 작성중 회차를 지우는 경로가 없다.
 */
export async function startInspectionRequestWithin(
  tx: Tx,
  inspectionRequestId: bigint,
  appUserId: number | undefined,
): Promise<void> {
  await tx.inspection_request.updateMany({
    where: { inspection_request_id: inspectionRequestId, status_code: REQUESTED },
    data: { status_code: IN_PROGRESS, updated_by: appUserId ?? null, version_no: { increment: 1 } },
  });
}

/**
 * 처분 재작업으로 검사 대기가 된 LOT 의 «IQC» 의뢰를 다시 연다. 부적합의 `inspection_request_id`(입하 LOT 판정 확정이 만든 부적합)를
 * 먼저 보고, 없으면 원 검사 결과 → 의뢰를 따라간다.
 * - 입하 LOT 검사(R-15): 재작업 판정이 자재 관리 LOT 전부를 검사 대기로 옮겼다 — 의뢰 `IN_PROGRESS`·확정 칸 비움·확정 주기 + 1·이력
 *   `REOPENED_BY_REWORK`. 앞 확정의 결과는 확정 그대로 판정 근거로 남고, 재검사 결과를 더해 다시 확정하면 그 결과로 LOT 전부를 옮긴다.
 * - 옛 LOT 검사: 그 의뢰의 LOT 이 이번에 옮겨진 경우만 `COMPLETED → IN_PROGRESS`(재검 회차를 쓴다).
 * ⛔ PQC·제품 LOT 재작업(재작업 W/O · #47)은 건드리지 않는다 — 의뢰가 W/O 대상이고 재검사가 그 W/O 를 탄다.
 */
export async function reopenIqcRequestForReworkWithin(
  tx: Tx,
  nonconformanceId: bigint,
  movedLotIds: readonly bigint[],
  appUserId: number,
): Promise<void> {
  const select = {
    inspection_request_id: true, inspection_type_code: true, target_type_code: true, lot_id: true, status_code: true,
    overall_judgment_code: true, confirmed_at: true,
  } as const;
  const source = await tx.nonconformance.findUnique({
    where: { nonconformance_id: nonconformanceId },
    select: { inspection_request: { select }, inspection_result: { select: { inspection_request: { select } } } },
  });
  const request = source?.inspection_request ?? source?.inspection_result?.inspection_request;
  if (request === undefined || request === null || request.inspection_type_code !== IQC) return;
  if (request.target_type_code !== INBOUND_LOT_TARGET) {
    if (request.lot_id === null || !movedLotIds.includes(request.lot_id)) return;
    await reopenInspectionRequestWithin(tx, request.inspection_request_id, appUserId);
    return;
  }
  if (movedLotIds.length === 0 || request.status_code !== COMPLETED) return;
  const at = new Date();
  await tx.inspection_request.update({
    where: { inspection_request_id: request.inspection_request_id },
    data: {
      // 검사 수준은 다시 확정할 때 그때의 품목 수준으로 적는다(확정 취소와 같다).
      status_code: IN_PROGRESS, overall_judgment_code: null, confirmed_at: null, confirmed_by: null, inspection_level_code: null,
      confirm_cycle: { increment: 1 }, updated_by: appUserId, version_no: { increment: 1 },
    },
  });
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: request.inspection_request_id, eventTypeCode: 'REOPENED_BY_REWORK', actor: { appUserId }, at,
    summaryBefore: {
      statusCode: request.status_code, overallJudgmentCode: request.overall_judgment_code,
      confirmedAt: request.confirmed_at?.toISOString() ?? null, nonconformanceId: Number(nonconformanceId),
    },
    summaryAfter: { statusCode: IN_PROGRESS },
  });
}
