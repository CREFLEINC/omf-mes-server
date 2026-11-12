import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { InspectionRequestEventActor, recordInspectionRequestEvent } from './inspection-request-event';
import { INBOUND_LOT_TARGET, assertRequestOpen, resultSummaryWithin } from './iqc-inbound-lot-result';

const INVALID_STATE = 'INVALID_STATE';

interface LockedResult {
  status_code: string;
  version_no: number;
  inspection_request_id: bigint;
  inspection_type_code: string;
  target_type_code: string;
  request_status_code: string;
}

/**
 * 입하 LOT 검사 결과 삭제(`DELETE /quality/inspection-results/{id}` · 피처 005 R-10). IQC·작성중·요청이 기록 중(대기·진행)일 때만 —
 * 측정치·초안 불량 기록·매칭을 함께 지우고, 이력(`RESULT_DELETED`)에 전 요약을 남긴다(지운 순번은 다시 쓰지 않는다).
 * ⛔ 수리 이력이 붙은 불량 기록이 있으면 지우지 않는다(409) — 그 FK 가 500 으로 새기 전에 막는다.
 * 이전된 옛 요청·PQC·OQC 결과는 지우지 않는다 — 회차 사슬이 끊긴다(FR-051).
 */
export async function deleteInboundLotResultWithin(
  tx: Prisma.TransactionClient,
  inspectionResultId: bigint,
  version: number,
  actor: InspectionRequestEventActor,
): Promise<void> {
  const [row] = await tx.$queryRaw<LockedResult[]>`
    SELECT r.status_code, r.version_no, r.inspection_request_id, q.inspection_type_code, q.target_type_code,
           q.status_code AS request_status_code
      FROM quality.inspection_result r
      JOIN quality.inspection_request q ON q.inspection_request_id = r.inspection_request_id
     WHERE r.inspection_result_id = ${inspectionResultId}
       FOR UPDATE OF r, q`;
  if (row === undefined) throw new NotFoundException('없는 검사 결과입니다.');
  if (row.version_no !== version) assertUpdated(0, 'user', { code: 'VERSION_CONFLICT', currentVersion: String(row.version_no) });
  if (row.inspection_type_code !== 'IQC' || row.target_type_code !== INBOUND_LOT_TARGET) {
    throw new ConflictException('user', '입하 LOT 검사의 결과만 지울 수 있습니다.', { code: INVALID_STATE });
  }
  if (row.status_code !== 'DRAFT') throw new ConflictException('user', '확정된 검사 결과는 지울 수 없습니다.', { code: INVALID_STATE });
  assertRequestOpen(row.request_status_code);

  const defects = await tx.defect_record.findMany({ where: { inspection_result_id: inspectionResultId }, select: { defect_record_id: true } });
  const defectIds = defects.map((defect) => defect.defect_record_id);
  const repaired = defectIds.length === 0 ? 0 : (await Promise.all([
    tx.repair_result.count({ where: { defect_record_id: { in: defectIds } } }),
    tx.repair_execution.count({ where: { defect_record_id: { in: defectIds } } }),
  ])).reduce((sum, count) => sum + count, 0);
  if (repaired > 0) {
    throw new ConflictException('user', '이 결과의 불량 기록에 수리 이력이 있어 지울 수 없습니다.', { code: INVALID_STATE });
  }

  const summaryBefore = await resultSummaryWithin(tx, inspectionResultId);
  await tx.defect_record.deleteMany({ where: { inspection_result_id: inspectionResultId } });
  await tx.inspection_measurement.deleteMany({ where: { inspection_result_id: inspectionResultId } });
  await tx.inspection_result_lot.deleteMany({ where: { inspection_result_id: inspectionResultId } });
  await tx.inspection_result.delete({ where: { inspection_result_id: inspectionResultId } });
  await recordInspectionRequestEvent(tx, {
    inspectionRequestId: row.inspection_request_id, eventTypeCode: 'RESULT_DELETED', inspectionResultId,
    actor, at: new Date(), summaryBefore,
  });
}
