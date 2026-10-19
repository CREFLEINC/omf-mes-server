import { Tx } from '../../core/lot';

const IQC = 'IQC';
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
 * 처분 재작업으로 검사 대기가 된 LOT 의 «IQC» 의뢰를 다시 연다. 부적합 → 원 검사 결과 → 의뢰를 따라가
 * 그 의뢰의 LOT 이 이번에 옮겨진 경우만이다.
 * ⛔ PQC·제품 LOT 재작업(재작업 W/O · #47)은 건드리지 않는다 — 의뢰가 W/O 대상이고 재검사가 그 W/O 를 탄다.
 */
export async function reopenIqcRequestForReworkWithin(
  tx: Tx,
  nonconformanceId: bigint,
  movedLotIds: readonly bigint[],
  appUserId: number,
): Promise<void> {
  const source = await tx.nonconformance.findUnique({
    where: { nonconformance_id: nonconformanceId },
    select: {
      inspection_result: {
        select: {
          inspection_request: {
            select: { inspection_request_id: true, inspection_type_code: true, lot_id: true },
          },
        },
      },
    },
  });
  const request = source?.inspection_result?.inspection_request;
  if (request === undefined || request.inspection_type_code !== IQC || request.lot_id === null) return;
  if (!movedLotIds.includes(request.lot_id)) return;
  await reopenInspectionRequestWithin(tx, request.inspection_request_id, appUserId);
}
