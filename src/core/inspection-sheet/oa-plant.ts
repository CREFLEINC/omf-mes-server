import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/** 공통코드 그룹 — 제품 검사표를 쓰는 공장(OA) 코드. */
export const OA_PLANT_GROUP = 'INSPECTION_SHEET_PLANT';

/** 계정의 데이터 범위 한 줄 — 공장이 없으면 그 사업부의 모든 공장이다(세션 `scopes` 의 뜻). */
export interface PlantScope {
  businessUnitId: number;
  plantId?: number;
}

/** OA 공장 id 들 — 공장 코드가 공통코드 `INSPECTION_SHEET_PLANT` 의 사용 중인 값인 공장. */
export async function oaPlantIds(prisma: Pick<Prisma.TransactionClient, 'plant' | 'code_value'>): Promise<bigint[]> {
  return (await oaPlants(prisma)).map((plant) => plant.plant_id);
}

/**
 * ⚠ 사업부(VIETNAM)가 부품·OA 두 공장을 함께 가져 사업부로는 가를 수 없다(담당자 결정 2026-10-21 — 공장으로 판단 ·
 * omf-all-around#89 · 장부 P-102).
 */
async function oaPlants(prisma: Pick<Prisma.TransactionClient, 'plant' | 'code_value'>) {
  const codes = await prisma.code_value.findMany({
    where: { is_active: true, code_group: { group_code: OA_PLANT_GROUP } },
    select: { code: true },
  });
  if (codes.length === 0) return [];
  return prisma.plant.findMany({
    where: { plant_code: { in: codes.map((row) => row.code) } },
    select: { plant_id: true, business_unit_id: true },
  });
}

/** 계정 범위가 덮는 OA 공장 id 들. 비어 있으면 그 계정은 검사표 화면을 쓸 수 없다. */
export async function oaPlantsInScope(
  prisma: Pick<Prisma.TransactionClient, 'plant' | 'code_value'>,
  scopes: readonly PlantScope[],
): Promise<bigint[]> {
  if (scopes.length === 0) return [];
  const plants = await oaPlants(prisma);
  return plants
    .filter((plant) =>
      scopes.some((scope) =>
        scope.plantId === undefined
          ? BigInt(scope.businessUnitId) === plant.business_unit_id
          : BigInt(scope.plantId) === plant.plant_id,
      ),
    )
    .map((plant) => plant.plant_id);
}

export function oaOnly(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '이 화면은 OA 사업부 전용입니다.' },
  ]);
}
