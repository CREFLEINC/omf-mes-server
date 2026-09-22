import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * 취급 단위가 단말 공장 것인가 — 단말 요청의 포장 소유 판정은 이 파일 한 곳이다.
 *
 * 창고·위치가 있으면 그 공장이다. **둘 다 비었으면 «만든 단말의 공장»이다**(omf-all-around#57).
 * POP 포장 작업(P-02-08)은 창고 칸 없이 포장을 만든다 — 창고·위치로만 가르면 그 포장은 어느
 * 공장에도 속하지 않아 확정·조회·모바일 입고가 전부 401/미발견이 된다. 단말이 만든 포장에는
 * 생성 감사(`HANDLING_UNIT`·`CREATE` · `handling-unit.service.ts`)가 단말과 함께 남는다.
 *
 * ⚠ 관리웹이 창고 없이 만든 포장은 단말 감사가 없어 여전히 어느 단말 공장에도 속하지 않는다.
 */
export function placedInPlant(plantId: bigint): Prisma.handling_unitWhereInput[] {
  return [{ warehouse: { plant_id: plantId } }, { location: { warehouse: { plant_id: plantId } } }];
}

export async function handlingUnitInPlant(
  prisma: PrismaService, handlingUnitId: bigint, plantId: bigint,
): Promise<boolean> {
  const unit = await prisma.handling_unit.findFirst({
    where: { handling_unit_id: handlingUnitId, OR: [...placedInPlant(plantId), { warehouse_id: null, location_id: null }] },
    select: { warehouse_id: true, location_id: true },
  });
  if (!unit) return false;
  if (unit.warehouse_id !== null || unit.location_id !== null) return true;
  return (await createdByPlantTerminal(prisma, [handlingUnitId], plantId)).length > 0;
}

/** 창고·위치 없는 후보 중 이 공장 단말이 만든 것만 남긴다. */
export async function createdByPlantTerminal(
  prisma: PrismaService, handlingUnitIds: readonly bigint[], plantId: bigint,
): Promise<bigint[]> {
  if (handlingUnitIds.length === 0) return [];
  const rows = await prisma.audit_event.findMany({
    where: {
      target_type_code: 'HANDLING_UNIT', event_type_code: 'CREATE',
      target_id: { in: [...handlingUnitIds] }, terminal: { plant_id: plantId },
    },
    select: { target_id: true },
    distinct: ['target_id'],
  });
  return rows.map((row) => row.target_id);
}
