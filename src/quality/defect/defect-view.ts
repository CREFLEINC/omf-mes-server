import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { omitEmpty } from '../../common/http/omit-empty';

/** 계약 `DefectRecord`(21칸) 매퍼 — 결손 0, 물리와 1:1(§2-2). */
export type DefectRecordRow = Prisma.defect_recordGetPayload<object>;

export type DefectRecordView = ReturnType<typeof defectRecordView>;

export function defectRecordView(row: DefectRecordRow) {
  return omitEmpty({
    defectRecordId: Number(row.defect_record_id),
    productionResultId: row.production_result_id === null ? undefined : Number(row.production_result_id),
    inspectionResultId: row.inspection_result_id === null ? undefined : Number(row.inspection_result_id),
    // 물리 칸 이름은 `source_type_code` 다 — 계약 `x-source-column` 은 `source_code` 라 적었다
    // (§2-2 · 알려둘 것 ⓑ). 컬럼을 갈지 않고 여기서 매핑한다.
    sourceCode: row.source_type_code ?? undefined,
    // ⭐ required 인데 물리는 nullable — 클레임 원천은 W/O 가 없다(계약 `:workOrderId` 설명).
    // 계약 타입이 `[integer,null]` 이라 여기는 예외적으로 `null` 을 그대로 싣는다(키 생략이 아니다).
    workOrderId: row.work_order_id === null ? null : Number(row.work_order_id),
    lotId: row.lot_id === null ? undefined : Number(row.lot_id),
    defectCodeId: Number(row.defect_code_id),
    suspectedCauseCodeId: row.suspected_cause_code_id === null ? undefined : Number(row.suspected_cause_code_id),
    confirmedCauseCodeId: row.confirmed_cause_code_id === null ? undefined : Number(row.confirmed_cause_code_id),
    responsibilityTypeCode: row.responsibility_type_code ?? undefined,
    responsibleDepartmentId: row.responsible_department_id === null ? undefined : Number(row.responsible_department_id),
    workerId: row.worker_id === null ? undefined : Number(row.worker_id),
    defectDescription: row.defect_description ?? undefined,
    defectQty: Number(row.defect_qty),
    uomId: Number(row.uom_id),
    occurrenceProcessId: Number(row.occurrence_process_id),
    detectionProcessId: Number(row.detection_process_id),
    equipmentId: row.equipment_id === null ? undefined : Number(row.equipment_id),
    moldId: row.mold_id === null ? undefined : Number(row.mold_id),
    occurredAt: row.occurred_at?.toISOString(),
    detectedAt: row.detected_at.toISOString(),
  });
}

/**
 * 목록·분포 공유 — 기간 갈래 C. 설명은 「기간 필수(공유계약 L-3)」인데 계약이 `required`도
 * 400도 선언하지 않았다. 거부→허용은 호환 완화라(§2 2단계 기준 2) 400 REQUIRED 로 잠근다.
 * // 결정 — 통보 074
 */
export function assertDetectedPeriodRequired(query: { detectedFrom?: string; detectedTo?: string }): void {
  if (query.detectedFrom !== undefined && query.detectedTo !== undefined) return;
  const missing = query.detectedFrom === undefined ? 'detectedFrom' : 'detectedTo';
  throw one(field(missing, ERROR_CODE.REQUIRED, '기간(detectedFrom·detectedTo)이 필요합니다.'));
}

/** ⛔ 끝 경계는 «미만»이다(반열림 · 공유계약 L-3-1) — `detected_at >= from AND detected_at < to`. */
export function detectedAtWhere(from: string, to: string): Prisma.defect_recordWhereInput {
  return { detected_at: { gte: new Date(from), lt: new Date(to) } };
}
