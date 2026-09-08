import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues, toDateString } from '../../common/master';
import { resolveEffectiveAssignments } from '../../core/equipment-assignment';

/**
 * 점검항목 «부여» — 설비와 설비그룹 두 층에 같은 모양으로 붙는다.
 *
 * 계약이 두 층에 같은 입력 스키마(`InspectionItemAssignmentInput`)를 쓰고, 응답의 한 줄도
 * 같은 모양이다(`InspectionItemAssignment`) — 부여가 정하는 것은 주기·활성 여부뿐이고,
 * 나머지 칸은 점검항목 마스터에서 온다.
 *
 * ⛔ 잠금 축은 부모(설비 / 그룹)의 `version_no` 다. 부여 표에 `version_no` 가 없고,
 * 계약이 「토큰은 같은 경로의 조회가 내려주는 ETag 다」로 적었다 — 앞의 자식 컬렉션들과
 * 같은 판단이다(#115·#118·#120).
 */

/** 계약 `InspectionItemAssignment` 와 동형 — 부여 + 항목 마스터를 합친 한 줄. */
export interface AssignmentView {
  equipmentInspectionItemId: number;
  itemCode: string;
  itemName: string;
  inspectionTypeCode: string;
  judgmentMethodCode: string;
  uomId: number | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  requiredFlag: boolean;
  inspectionPoint: string | null;
  sequenceNo: number;
  isActive: boolean;
  cycleTypeCode: string;
  cycleInterval: number;
  cycleBaseDate: string | null;
}

export interface AssignmentInput {
  equipmentInspectionItemId: number;
  isActive?: boolean;
  cycleTypeCode: string;
  cycleInterval: number;
  cycleBaseDate?: string | null;
}

export interface GroupAssignments {
  items: AssignmentView[];
  versionNo: number;
}

/** 계약 `EquipmentInspectionItemAssignmentsResponse` — 해석 결과를 함께 낸다. */
export interface EquipmentAssignments {
  assigned: AssignmentView[];
  effective: AssignmentView[];
  resolvedFromLevelCode: 'EQUIPMENT' | 'EQUIPMENT_GROUP' | 'NONE';
  resolvedFromGroupId: number | null;
  versionNo: number;
}

type ItemRow = Prisma.equipment_inspection_itemGetPayload<object>;

@Injectable()
export class InspectionAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 그룹 ────────────────────────────────────────────────────────────────

  async listGroupAssignments(equipmentGroupId: number): Promise<GroupAssignments> {
    const versionNo = await this.groupVersion(equipmentGroupId);
    return { items: await this.readGroupAssignments(equipmentGroupId), versionNo };
  }

  async replaceGroupAssignments(
    equipmentGroupId: number,
    version: number,
    items: AssignmentInput[],
    appUserId?: number,
  ): Promise<GroupAssignments> {
    await this.assertInputs(items);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.production_line.updateMany({
        where: { production_line_id: equipmentGroupId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.production_line.findUnique({
          where: { production_line_id: equipmentGroupId },
          select: { production_line_id: true },
        });
        if (!exists) throw new NotFoundException('없는 설비 그룹입니다.');
        assertUpdated(0);
      }

      await tx.equipment_group_inspection_item.deleteMany({
        where: { production_line_id: equipmentGroupId },
      });
      if (items.length === 0) return;
      await tx.equipment_group_inspection_item.createMany({
        data: items.map((item) => ({
          production_line_id: equipmentGroupId,
          equipment_inspection_item_id: item.equipmentInspectionItemId,
          cycle_type_code: item.cycleTypeCode,
          cycle_interval: item.cycleInterval,
          cycle_base_date: item.cycleBaseDate == null ? null : new Date(item.cycleBaseDate),
          ...(item.isActive === undefined ? {} : { is_active: item.isActive }),
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });

    return this.listGroupAssignments(equipmentGroupId);
  }

  // ── 설비 ────────────────────────────────────────────────────────────────

  /**
   * 「설비에 부여가 있으면 그것, 없으면 소속 그룹의 것, 둘 다 없으면 점검 대상이 아니다.
   * 가장 가까운 것이 이긴다」 — 공유계약 `B-17`.
   *
   * 그룹은 나무다(`parent_line_id`). 「가장 가까운」을 소속 그룹 하나로만 읽으면 상위
   * 그룹에 붙인 부여가 어디에도 닿지 않아 계층이 뜻을 잃는다. 그래서 소속 그룹부터
   * 위로 올라가며 «처음 만나는» 부여를 쓴다 — 되돌림 문서에 적었다.
   */
  async listEquipmentAssignments(equipmentId: number): Promise<EquipmentAssignments> {
    const equipment = await this.prisma.equipment.findUnique({
      where: { equipment_id: equipmentId },
      select: { version_no: true, production_line_id: true },
    });
    if (!equipment) throw new NotFoundException('없는 설비입니다.');

    const resolved = await resolveEffectiveAssignments(equipment.production_line_id, {
      readEquipmentAssignments: () => this.readEquipmentAssignments(equipmentId),
      readGroupAssignments: (groupId) => this.readGroupAssignments(groupId),
      readParentGroupId: async (groupId) => {
        const parent = await this.prisma.production_line.findUnique({
          where: { production_line_id: groupId },
          select: { parent_line_id: true },
        });
        return parent?.parent_line_id ?? null;
      },
    });
    return {
      assigned: resolved.levelCode === 'EQUIPMENT' ? resolved.assignments : [],
      effective: resolved.assignments,
      resolvedFromLevelCode: resolved.levelCode,
      resolvedFromGroupId: resolved.groupId === null ? null : Number(resolved.groupId),
      versionNo: equipment.version_no,
    };
  }

  /** 「빈 목록을 보내면 이 설비의 직접 부여가 사라지고 소속 그룹의 것을 따르게 된다」(계약). */
  async replaceEquipmentAssignments(
    equipmentId: number,
    version: number,
    items: AssignmentInput[],
    appUserId?: number,
  ): Promise<EquipmentAssignments> {
    await this.assertInputs(items);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.equipment.updateMany({
        where: { equipment_id: equipmentId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.equipment.findUnique({
          where: { equipment_id: equipmentId },
          select: { equipment_id: true },
        });
        if (!exists) throw new NotFoundException('없는 설비입니다.');
        assertUpdated(0);
      }

      await tx.equipment_inspection_item_assignment.deleteMany({
        where: { equipment_id: equipmentId },
      });
      if (items.length === 0) return;
      await tx.equipment_inspection_item_assignment.createMany({
        data: items.map((item) => ({
          equipment_id: equipmentId,
          equipment_inspection_item_id: item.equipmentInspectionItemId,
          cycle_type_code: item.cycleTypeCode,
          cycle_interval: item.cycleInterval,
          cycle_base_date: item.cycleBaseDate == null ? null : new Date(item.cycleBaseDate),
          ...(item.isActive === undefined ? {} : { is_active: item.isActive }),
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });

    return this.listEquipmentAssignments(equipmentId);
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  private async readGroupAssignments(equipmentGroupId: number | bigint): Promise<AssignmentView[]> {
    const rows = await this.prisma.equipment_group_inspection_item.findMany({
      where: { production_line_id: equipmentGroupId },
      include: { equipment_inspection_item: true },
    });
    return rows.map((row) => view(row, row.equipment_inspection_item)).sort(bySequence);
  }

  private async readEquipmentAssignments(equipmentId: number): Promise<AssignmentView[]> {
    const rows = await this.prisma.equipment_inspection_item_assignment.findMany({
      where: { equipment_id: equipmentId },
      include: { equipment_inspection_item: true },
    });
    return rows.map((row) => view(row, row.equipment_inspection_item)).sort(bySequence);
  }

  private async groupVersion(equipmentGroupId: number): Promise<number> {
    const row = await this.prisma.production_line.findUnique({
      where: { production_line_id: equipmentGroupId },
      select: { version_no: true },
    });
    if (!row) throw new NotFoundException('없는 설비 그룹입니다.');
    return row.version_no;
  }

  /**
   * 통째로 교체하는 본문이라 어느 줄이 문제인지 짚어야 한다 — 앞의 컬렉션들과 같다.
   * 유일 제약(부모 + 항목)도 같은 자리에서 본다.
   */
  private async assertInputs(items: AssignmentInput[]): Promise<void> {
    const errors: ErrorItem[] = [];
    const seen = new Map<number, number>();
    items.forEach((item, index) => {
      const first = seen.get(item.equipmentInspectionItemId);
      if (first === undefined) {
        seen.set(item.equipmentInspectionItemId, index);
        return;
      }
      errors.push({
        scope: 'field',
        field: `items[${index}].equipmentInspectionItemId`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['equipmentInspectionItemId'],
        message: `${first + 1}번째 줄과 같은 점검항목입니다.`,
      });
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (items.length === 0) return;

    // 부여 대상이 «쓰는» 점검항목인지 본다. FK 는 존재만 보고 사용 중지는 안 본다 —
    // 중지한 항목을 새로 부여하면 중지의 뜻이 없어진다.
    const known = await this.prisma.equipment_inspection_item.findMany({
      where: {
        is_active: true,
        equipment_inspection_item_id: { in: [...seen.keys()] },
      },
      select: { equipment_inspection_item_id: true },
    });
    const knownIds = new Set(known.map((row) => Number(row.equipment_inspection_item_id)));
    for (const [itemId, index] of seen) {
      if (knownIds.has(itemId)) continue;
      errors.push({
        scope: 'field',
        field: `items[${index}].equipmentInspectionItemId`,
        code: ERROR_CODE.INVALID,
        message: '없거나 사용 중지된 점검항목입니다.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(
      this.prisma,
      items.map((item, index) => ({
        field: `items[${index}].cycleTypeCode`,
        value: item.cycleTypeCode,
        groupCode: 'CYCLE_TYPE',
      })),
    );
  }
}

function bySequence(a: AssignmentView, b: AssignmentView): number {
  return a.sequenceNo - b.sequenceNo || a.itemCode.localeCompare(b.itemCode);
}

function view(
  row: {
    is_required_override: boolean | null;
    is_active: boolean;
    cycle_type_code: string;
    cycle_interval: number;
    cycle_base_date: Date | null;
  },
  item: ItemRow,
): AssignmentView {
  return {
    equipmentInspectionItemId: Number(item.equipment_inspection_item_id),
    itemCode: item.inspection_item_code,
    itemName: item.inspection_item_name,
    inspectionTypeCode: item.inspection_type_code,
    judgmentMethodCode: item.judgment_method_code,
    uomId: item.uom_id === null ? null : Number(item.uom_id),
    lowerLimit: item.lower_limit === null ? null : Number(item.lower_limit),
    upperLimit: item.upper_limit === null ? null : Number(item.upper_limit),
    // 부여가 덮어썼으면 그것, 아니면 항목 마스터의 값. 계약 입력에는 이 칸이 없어
    // 지금은 항상 마스터 값이지만, 물리 컬럼이 있으므로 존중한다.
    requiredFlag: row.is_required_override ?? item.is_required,
    inspectionPoint: item.inspection_point,
    sequenceNo: item.sequence_no,
    isActive: row.is_active,
    cycleTypeCode: row.cycle_type_code,
    cycleInterval: row.cycle_interval,
    cycleBaseDate: toDateString(row.cycle_base_date),
  };
}
