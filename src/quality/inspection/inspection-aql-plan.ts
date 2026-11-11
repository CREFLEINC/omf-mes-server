import { Prisma } from '@prisma/client';

import { AQL_SAMPLING, AqlPlan, aqlPlan } from '../../core/quality/aql';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `InspectionAqlPlan` 과 동형(omf-all-around#264). */
export interface InspectionAqlPlanView extends AqlPlan {
  aqlValue: number;
  aqlInspectionLevelCode: string;
}

type AqlVersion = {
  sampling_method_code: string;
  aql_value: Prisma.Decimal | null;
  aql_inspection_level_code: string | null;
};

/** 판정 기준을 고르는 데 읽는 버전 칸 — `select` 에 그대로 쓴다. */
export const AQL_VERSION_SELECT = {
  sampling_method_code: true,
  aql_value: true,
  aql_inspection_level_code: true,
  acceptance_number: true,
} as const;

/** AQL 샘플링 버전이면 의뢰 수량(LOT 크기)으로 표에서 낸 계획, 다른 방식이거나 AQL 값 · 수준이 비면 null. */
export function aqlPlanOf(version: AqlVersion | null, targetQty: Prisma.Decimal): InspectionAqlPlanView | null {
  if (version?.sampling_method_code !== AQL_SAMPLING) return null;
  if (version.aql_value === null || version.aql_inspection_level_code === null) return null;
  const aqlValue = version.aql_value.toNumber();
  const plan = aqlPlan(Math.floor(targetQty.toNumber()), version.aql_inspection_level_code, aqlValue);
  return plan === null ? null : { aqlValue, aqlInspectionLevelCode: version.aql_inspection_level_code, ...plan };
}

/** 자동 판정의 합격판정개수 — AQL 버전이면 표의 Ac, 아니면 버전에 적은 값(omf-all-around#125 · #264). */
export function acceptanceNumberOf(
  version: (AqlVersion & { acceptance_number: number | null }) | null,
  targetQty: Prisma.Decimal,
): number | null {
  return aqlPlanOf(version, targetQty)?.acceptanceNumber ?? version?.acceptance_number ?? null;
}

/** 의뢰 상세의 AQL 시료 계획(omf-all-around#264). */
export async function inspectionAqlPlan(
  prisma: PrismaService,
  request: { inspection_plan_version_id: bigint | null; target_qty: Prisma.Decimal },
): Promise<InspectionAqlPlanView | null> {
  if (request.inspection_plan_version_id === null) return null;
  const version = await prisma.inspection_plan_version.findUnique({
    where: { inspection_plan_version_id: request.inspection_plan_version_id },
    select: AQL_VERSION_SELECT,
  });
  return aqlPlanOf(version, request.target_qty);
}
