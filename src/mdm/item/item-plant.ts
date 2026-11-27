import { Prisma } from '@prisma/client';

/**
 * 품목에는 공장 칸이 없어 BOM 으로 정한다 — 모품목이나 구성품으로 든 BOM 중 그 공장 것이 있으면 그 공장 품목이다.
 * 공장이 정해진 BOM 에 한 번도 들지 않은 품목은 공장을 몰라 어느 공장에도 든다(클라이언트 요청 2026-11-26).
 */
export function itemPlantWhere(plantId: number): Prisma.itemWhereInput {
  const inPlant = { plant_id: plantId };
  const known = { plant_id: { not: null } };
  return {
    OR: [
      { bom: { some: inPlant } },
      { bom_component: { some: { bom: inPlant } } },
      { bom: { none: known }, bom_component: { none: { bom: known } } },
    ],
  };
}
