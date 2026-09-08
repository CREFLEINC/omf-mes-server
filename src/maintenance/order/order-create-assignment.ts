import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field, one } from "../../common/errors";
import { resolveEffectiveAssignments } from "../../core/equipment-assignment";

type Tx = Prisma.TransactionClient;

export interface LockedOrderEquipment {
  equipment_id: bigint;
  plant_id: bigint;
  production_line_id: bigint | null;
}

interface OrderItemReference {
  inspectionItemId: bigint | null;
}

interface Assignment {
  assignmentId: bigint;
  itemId: bigint;
  isActive: boolean;
}

interface InspectionItem {
  equipment_inspection_item_id: bigint;
  plant_id: bigint;
  inspection_type_code: string;
  is_active: boolean;
}

export class MaintenanceAssignmentPathChanged extends Error {}

/** 후보 경로를 정렬 잠근 뒤 재해석하고, 요청 항목이 최종 유효 부여인지 확정한다. */
export async function assertMaintenanceOrderAssignments(
  tx: Tx,
  target: LockedOrderEquipment,
  items: readonly OrderItemReference[],
): Promise<void> {
  const first = await resolveAssignments(tx, target);
  const path = [...new Set(first.groupPath)].sort(bigintOrder);
  if (path.length) {
    const locked = await tx.$queryRaw<
      { production_line_id: bigint }[]
    >(Prisma.sql`
      SELECT production_line_id FROM mdm.production_line
      WHERE production_line_id IN (${Prisma.join(path)})
      ORDER BY production_line_id FOR SHARE`);
    if (locked.length !== path.length)
      throw new MaintenanceAssignmentPathChanged();
  }
  const resolved = await resolveAssignments(tx, target);
  if (assignmentKey(first) !== assignmentKey(resolved))
    throw new MaintenanceAssignmentPathChanged();

  const itemIds = [
    ...new Set(resolved.assignments.map(({ itemId }) => itemId)),
  ].sort(bigintOrder);
  const masters = itemIds.length
    ? await tx.$queryRaw<InspectionItem[]>(Prisma.sql`
        SELECT equipment_inspection_item_id,plant_id,inspection_type_code,is_active
        FROM mdm.equipment_inspection_item
        WHERE equipment_inspection_item_id IN (${Prisma.join(itemIds)})
        ORDER BY equipment_inspection_item_id FOR SHARE`)
    : [];
  assertRequestedItems(target, items, resolved.assignments, masters);
}

async function resolveAssignments(tx: Tx, target: LockedOrderEquipment) {
  return resolveEffectiveAssignments(target.production_line_id, {
    readEquipmentAssignments: async () =>
      (
        await tx.equipment_inspection_item_assignment.findMany({
          where: { equipment_id: target.equipment_id },
          select: {
            equipment_inspection_item_assignment_id: true,
            equipment_inspection_item_id: true,
            is_active: true,
          },
        })
      ).map((row) => ({
        assignmentId: row.equipment_inspection_item_assignment_id,
        itemId: row.equipment_inspection_item_id,
        isActive: row.is_active,
      })),
    readGroupAssignments: async (groupId) =>
      (
        await tx.equipment_group_inspection_item.findMany({
          where: { production_line_id: groupId },
          select: {
            equipment_group_inspection_item_id: true,
            equipment_inspection_item_id: true,
            is_active: true,
          },
        })
      ).map((row) => ({
        assignmentId: row.equipment_group_inspection_item_id,
        itemId: row.equipment_inspection_item_id,
        isActive: row.is_active,
      })),
    readParentGroupId: async (groupId) =>
      (
        await tx.production_line.findUnique({
          where: { production_line_id: groupId },
          select: { parent_line_id: true },
        })
      )?.parent_line_id ?? null,
  });
}

function assertRequestedItems(
  target: LockedOrderEquipment,
  requested: readonly OrderItemReference[],
  resolved: Assignment[],
  masters: InspectionItem[],
): void {
  const assignments = new Map(
    resolved.map((row) => [row.itemId.toString(), row]),
  );
  const items = new Map(
    masters.map((row) => [row.equipment_inspection_item_id.toString(), row]),
  );
  requested.forEach((item, index) => {
    const id = item.inspectionItemId?.toString() ?? "";
    const assignment = assignments.get(id);
    const master = items.get(id);
    if (
      !assignment?.isActive ||
      !master?.is_active ||
      master.plant_id !== target.plant_id ||
      master.inspection_type_code !== "MAINTENANCE"
    ) {
      throw invalid(
        `items[${index}].inspectionItemId`,
        "현재 설비에 부여된 사용 중 보전 항목이 아닙니다.",
      );
    }
  });
}

function assignmentKey(
  resolved: Awaited<ReturnType<typeof resolveAssignments>>,
): string {
  const assignments = resolved.assignments
    .map((row) => `${row.assignmentId}:${row.itemId}:${row.isActive}`)
    .sort()
    .join(",");
  return `${resolved.levelCode}|${resolved.groupId}|${resolved.groupPath.join(",")}|${assignments}`;
}

function invalid(name: string, message: string): ContractException {
  return one(field(name, ERROR_CODE.INVALID, message));
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
