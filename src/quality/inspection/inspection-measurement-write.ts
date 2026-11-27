import { Prisma } from '@prisma/client';

import { optional } from '../../common/master';
import { InspectionMeasurementInput } from './inspection-result-write-input';

/**
 * 검사 결과의 측정치 쓰기 — IQC·PQC·OQC 결과 저장과 출하 OQC 새 흐름(피처 010 T052 · FR-009)이 같은 함수를 쓴다.
 * 비었거나 없으면 아무것도 쓰지 않는다. 고칠 때는 부르는 쪽이 먼저 지운다(`replaceMeasurementsWithin`).
 */
export async function writeMeasurementsWithin(
  tx: Prisma.TransactionClient,
  inspectionResultId: bigint,
  measurements: readonly InspectionMeasurementInput[] | undefined,
  appUserId: number | undefined,
): Promise<void> {
  if (measurements === undefined || measurements.length === 0) return;
  await tx.inspection_measurement.createMany({
    data: measurements.map((measurement) => ({
      inspection_result_id: inspectionResultId,
      inspection_item_spec_id: BigInt(measurement.inspectionItemSpecId),
      sample_no: measurement.sampleNo,
      ...optional('numeric_value', measurement.numericValue),
      ...optional('text_value', measurement.textValue),
      ...optional('boolean_value', measurement.booleanValue),
      judgment_code: measurement.judgmentCode,
      measured_at: new Date(measurement.measuredAt),
      ...optional('inspection_equipment_id', measurement.inspectionEquipmentId === undefined ? undefined : BigInt(measurement.inspectionEquipmentId)),
      created_by: appUserId ?? null,
    })),
  });
}

/** PUT — 본문에 측정치가 오면 통째로 바꾼다(빈 배열이면 지운다). 안 오면 그대로 둔다. */
export async function replaceMeasurementsWithin(
  tx: Prisma.TransactionClient,
  inspectionResultId: bigint,
  measurements: readonly InspectionMeasurementInput[] | undefined,
  appUserId: number | undefined,
): Promise<void> {
  if (measurements === undefined) return;
  await tx.inspection_measurement.deleteMany({ where: { inspection_result_id: inspectionResultId } });
  await writeMeasurementsWithin(tx, inspectionResultId, measurements, appUserId);
}
