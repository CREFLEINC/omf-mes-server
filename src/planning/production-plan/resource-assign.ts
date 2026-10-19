import { unusable } from '../../core/work-order';
import { PrismaService } from '../../prisma/prisma.service';

/** 전개가 공정마다 읽는 Routing 공정의 칸. 공정 순서대로 넘긴다. */
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

/**
 * 공정별로 설비·금형을 칸마다 고른다. 그 공정을 지정한 매핑의 칸이 있으면 그것을, 비었으면 품목 공통 매핑의 칸을 쓴다.
 * 품목 공통 매핑은 그 칸이 필요한(`equipment_required`·`mold_required`) «첫» 공정에만 준다 —
 * 사출 품목의 조립 공정에 사출 금형이 붙지 않게, 같은 설비가 같은 계획 시간대의 W/O 여럿에 겹쳐 붙지 않게.
 */
export function assignResources(operations: OperationNeed[], maps: DefaultMap[]): Map<bigint, OperationResource> {
  const common = maps.find((map) => map.processId === null);
  let commonEquipmentUsed = false;
  let commonMoldUsed = false;
  const result = new Map<bigint, OperationResource>();
  for (const operation of operations) {
    const own = maps.find((map) => map.processId === operation.processId);
    let equipmentId = own?.equipmentId ?? null;
    let equipmentLineId = own?.equipmentId == null ? null : own.equipmentLineId;
    if (operation.equipmentRequired && !commonEquipmentUsed) {
      // 첫 필요 공정이 자기 매핑으로 채웠어도 공통 몫은 끝난다 — 뒤 공정에 같은 설비가 겹쳐 붙지 않게.
      if (equipmentId === null && common?.equipmentId != null) {
        equipmentId = common.equipmentId;
        equipmentLineId = common.equipmentLineId;
      }
      commonEquipmentUsed = true;
    }
    let moldId = own?.moldId ?? null;
    if (operation.moldRequired && !commonMoldUsed) {
      if (moldId === null && common?.moldId != null) moldId = common.moldId;
      commonMoldUsed = true;
    }
    result.set(operation.routingOperationId, { equipmentId, moldId, equipmentLineId });
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
  return rows.map((row) => toDefaultMap(row));
}

export function toDefaultMap(row: {
  process_id: bigint | null;
  equipment: { equipment_id: bigint; status_code: string; is_active: boolean; production_line_id: bigint | null } | null;
  mold: { mold_id: bigint; status_code: string; is_active: boolean } | null;
}): DefaultMap {
  const equipment = row.equipment !== null && !unusable(row.equipment) ? row.equipment : null;
  const mold = row.mold !== null && !unusable(row.mold) ? row.mold : null;
  return {
    processId: row.process_id,
    equipmentId: equipment?.equipment_id ?? null,
    equipmentLineId: equipment?.production_line_id ?? null,
    moldId: mold?.mold_id ?? null,
  };
}
