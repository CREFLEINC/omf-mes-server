import { Prisma } from '@prisma/client';

import { NotificationValues, activeDepartment } from '../../core/notification';

type Tx = Prisma.TransactionClient;

/**
 * 고장 알림의 부서·값. 부서는 설비 라인 «자신»의 담당 부서다(상속 없음 · research R-7).
 * `location` 은 「공장 > 상위 그룹 > 그룹」 — `EquipmentService.hierarchy()` 와 같은 규칙으로 위로 올라가며 잇는다.
 */
export async function breakdownNotice(
  tx: Tx,
  equipmentId: bigint,
  symptom: string,
  reporterName: string | undefined,
): Promise<{ departmentId: bigint | null; values: NotificationValues; zaloValues: NotificationValues }> {
  const equipment = await tx.equipment.findUniqueOrThrow({
    where: { equipment_id: equipmentId },
    select: {
      equipment_code: true,
      equipment_name: true,
      plant: { select: { plant_name: true } },
      production_line: {
        select: {
          line_name: true,
          parent_line_id: true,
          department: { select: { department_id: true, is_active: true } },
        },
      },
    },
  });
  const line = equipment.production_line;
  const groups = line === null ? [] : [...(await ancestorNames(tx, line.parent_line_id)), line.line_name];
  return {
    departmentId: activeDepartment(line?.department ?? null),
    values: {
      equipment: `${equipment.equipment_code} ${equipment.equipment_name}`,
      location: [equipment.plant.plant_name, ...groups].join(' > '),
      line: line?.line_name,
      symptom,
      actor: reporterName,
    },
    // Zalo 파라미터는 30자다 — 코드를 빼고 설비명만 싣는다(server #878).
    zaloValues: { equipment: equipment.equipment_name },
  };
}

/** 상위 그룹 이름을 뿌리부터. 순환이 있어도 멈춘다(`hierarchy()` 와 같다). */
async function ancestorNames(tx: Tx, parentId: bigint | null): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<bigint>();
  let current = parentId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const group: { line_name: string; parent_line_id: bigint | null } | null = await tx.production_line.findUnique({
      where: { production_line_id: current },
      select: { line_name: true, parent_line_id: true },
    });
    if (group === null) break;
    names.unshift(group.line_name);
    current = group.parent_line_id;
  }
  return names;
}
