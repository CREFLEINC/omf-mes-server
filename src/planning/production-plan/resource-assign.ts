import { PrismaService } from '../../prisma/prisma.service';

/** 전개가 공정마다 읽는 Routing 공정의 칸. */
export interface OperationNeed {
  routingOperationId: bigint;
  processId: bigint;
  equipmentRequired: boolean;
  moldRequired: boolean;
}

/** 품목의 기본 매핑 한 줄 — 쓸 수 없는 설비·금형은 읽을 때 이미 null 로 지웠다. */
export interface DefaultMap {
  processId: bigint | null;
  equipmentId: bigint | null;
  equipmentLineId: bigint | null;
  moldId: bigint | null;
}

export interface OperationResource {
  equipmentId: bigint | null;
  moldId: bigint | null;
  /** 배정된 설비의 라인 — 계획에 라인이 없을 때만 W/O 라인으로 쓴다. */
  equipmentLineId: bigint | null;
}

const IN_SERVICE = 'IN_SERVICE';

/**
 * 공정별 기본 매핑을 고른다. 그 공정을 지정한 매핑이 공정 미지정(품목 공통) 매핑을 이긴다.
 * 품목 공통 매핑은 금형이 필요한 공정에만 금형을, 설비가 필요한 공정에만 설비를 준다 —
 * 사출 품목의 조립 공정에 사출 금형이 붙지 않게 한다.
 */
export function assignResources(operations: OperationNeed[], maps: DefaultMap[]): Map<bigint, OperationResource> {
  const common = maps.find((map) => map.processId === null);
  const result = new Map<bigint, OperationResource>();
  for (const operation of operations) {
    const own = maps.find((map) => map.processId === operation.processId);
    const equipment = own ?? (operation.equipmentRequired ? common : undefined);
    const mold = own ?? (operation.moldRequired ? common : undefined);
    result.set(operation.routingOperationId, {
      equipmentId: equipment?.equipmentId ?? null,
      moldId: mold?.moldId ?? null,
      equipmentLineId: equipment?.equipmentId == null ? null : equipment.equipmentLineId,
    });
  }
  return result;
}

/** 활성 기본 매핑만 읽는다. 가동 상태가 아닌 설비·금형은 배정하지 않고 4M 에서 고르게 둔다. */
export async function readDefaultMaps(prisma: PrismaService, plantId: bigint, itemId: bigint): Promise<DefaultMap[]> {
  const rows = await prisma.item_resource_map.findMany({
    where: { plant_id: plantId, item_id: itemId, is_default: true, is_active: true },
    select: {
      process_id: true,
      equipment: { select: { equipment_id: true, status_code: true, is_active: true, production_line_id: true } },
      mold: { select: { mold_id: true, status_code: true, is_active: true } },
    },
  });
  return rows.map((row) => {
    const equipment = row.equipment !== null && usable(row.equipment) ? row.equipment : null;
    const mold = row.mold !== null && usable(row.mold) ? row.mold : null;
    return {
      processId: row.process_id,
      equipmentId: equipment?.equipment_id ?? null,
      equipmentLineId: equipment?.production_line_id ?? null,
      moldId: mold?.mold_id ?? null,
    };
  });
}

const usable = (resource: { status_code: string; is_active: boolean }): boolean =>
  resource.status_code === IN_SERVICE && resource.is_active;
