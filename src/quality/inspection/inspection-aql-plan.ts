import { AQL_SAMPLING, AqlPlan, aqlPlan } from '../../core/quality/aql';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionAqlPlan` 과 동형(omf-all-around#264). */
export interface InspectionAqlPlanView extends AqlPlan {
  aqlValue: number;
  aqlInspectionLevelCode: string;
}

/**
 * 의뢰의 AQL 시료 계획 — 의뢰가 쓰는 기준 버전이 AQL 샘플링이면 의뢰 수량(LOT 크기)으로 표에서 낸다.
 * 다른 방식이거나 AQL 값 · 수준이 비면 없다(null).
 */
export async function inspectionAqlPlan(
  prisma: PrismaService,
  request: { inspection_plan_version_id: bigint | null; target_qty: { toNumber(): number } },
): Promise<InspectionAqlPlanView | null> {
  if (request.inspection_plan_version_id === null) return null;
  const version = await prisma.inspection_plan_version.findUnique({
    where: { inspection_plan_version_id: request.inspection_plan_version_id },
    select: { sampling_method_code: true, aql_value: true, aql_inspection_level_code: true },
  });
  if (version?.sampling_method_code !== AQL_SAMPLING) return null;
  if (version.aql_value === null || version.aql_inspection_level_code === null) return null;
  const aqlValue = version.aql_value.toNumber();
  const plan = aqlPlan(Math.floor(request.target_qty.toNumber()), version.aql_inspection_level_code, aqlValue);
  return plan === null ? null : { aqlValue, aqlInspectionLevelCode: version.aql_inspection_level_code, ...plan };
}
