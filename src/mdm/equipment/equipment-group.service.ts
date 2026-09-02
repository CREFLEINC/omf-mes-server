import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues } from '../code-reference';
import { optional } from '../column';
import { Editability } from '../editability';
import { Referrer, countReferences } from '../reference-count';
import { ReferenceQuery, referencePage, referenceWhere } from '../reference/reference.query';

/**
 * ⛔ 설비 그룹의 저장처는 `mdm.production_line` 이다 — `mdm.equipment_group` 이 아니다.
 *
 * 계약 `EquipmentGroup` 의 다섯 칸이 `x-source-column` 으로 전부 그쪽을 가리킨다
 * (`production_line_id`·`line_code`·`line_name`·`line_type_code`·`parent_line_id`), 그리고
 * `groupCode` 에 「`uq_production_line(plant_id, line_code)`」까지 적어 두었다. 다섯이
 * 일관되고 유일 제약까지 짚었으므로 옮겨 적은 실수가 아니다.
 *
 * 즉 「설비 그룹」과 「생산라인·작업구역」은 **같은 나무의 같은 노드**이고, `W-05-12` 가
 * 사실상 그 마스터의 관리 화면이다(계약이 `/mdm/production-lines` 에 「관리 화면이
 * 인벤토리 108건에 없다 … 귀속 화면이 미정」이라 적은 것과 맞물린다).
 *
 * 그 결과 `mdm.equipment_group`·`mdm.equipment_group_member` 는 계약 어느 스키마도
 * 가리키지 않는 표가 된다 — 되돌림 문서에 적었다.
 */
export const EQUIPMENT_GROUP_REFERRERS: readonly Referrer[] = [
  ['maintenance.planned_stop', 'production_line_id'],
  ['mdm.equipment', 'production_line_id'],
  // 점검항목 부여도 그룹을 가리킨다(#123 이 FK 를 이쪽으로 옮겼다). 부여가 붙은 그룹은
  // 코드를 못 고친다 — 부여 화면이 그 코드로 그룹을 짚고 있다.
  ['mdm.equipment_group_inspection_item', 'production_line_id'],
  ['mdm.production_line', 'parent_line_id'],
  ['planning.production_plan', 'planned_line_id'],
  ['production.work_order', 'production_line_id'],
];

/** 계약 `EquipmentGroup` 과 동형. */
interface EquipmentGroupView {
  equipmentGroupId: number;
  plantId: number;
  groupCode: string;
  groupName: string;
  groupTypeCode: string;
  parentGroupId: number | null;
  isActive: boolean;
}

export interface EquipmentGroupCreate {
  plantId: number;
  groupCode: string;
  groupName: string;
  groupTypeCode: string;
  parentGroupId?: number | null;
}

export interface EquipmentGroupUpdate {
  groupCode?: string;
  groupName: string;
  groupTypeCode: string;
  parentGroupId?: number | null;
}

export interface EquipmentGroupQuery extends ReferenceQuery {
  plantId?: number;
  parentGroupId?: number;
}

type LineRow = Prisma.production_lineGetPayload<object>;

export type EquipmentGroupResult = {
  equipmentGroup: EquipmentGroupView;
  editability: Editability;
  memberEquipmentCount: number;
  versionNo: number;
};

@Injectable()
export class EquipmentGroupService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: EquipmentGroupQuery): Promise<PagedResponse<EquipmentGroupView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'line_code', name: 'line_name' }, {
      ...optional('plant_id', query.plantId),
      ...optional('parent_line_id', query.parentGroupId),
    });
    const [rows, total] = await Promise.all([
      this.prisma.production_line.findMany({
        where,
        // 코드는 공장 안에서만 유일하다(uq_production_line) — 공장을 앞세운다.
        orderBy: [{ plant_id: 'asc' }, { line_code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.production_line.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(equipmentGroupId: number): Promise<EquipmentGroupResult> {
    const row = await this.prisma.production_line.findUnique({
      where: { production_line_id: equipmentGroupId },
    });
    if (!row) throw new NotFoundException('없는 설비 그룹입니다.');

    const [referenceCount, memberEquipmentCount] = await Promise.all([
      countReferences(this.prisma, EQUIPMENT_GROUP_REFERRERS, row.production_line_id),
      // 「이 그룹에 소속된 설비 대수. 사용 중지 확인 문구가 이 값을 쓴다」(계약).
      this.prisma.equipment.count({ where: { production_line_id: row.production_line_id } }),
    ]);
    return {
      equipmentGroup: view(row),
      // 그룹 코드를 «글자»로 부르는 자리는 계약에 0곳이라 FK 건수가 곧 답이다.
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      memberEquipmentCount,
      versionNo: row.version_no,
    };
  }

  async create(input: EquipmentGroupCreate): Promise<EquipmentGroupView> {
    await this.assertGroupType(input.groupTypeCode);
    if (input.parentGroupId != null) {
      await this.assertParent(input.plantId, input.parentGroupId, null);
    }
    return view(
      await this.prisma.production_line.create({
        data: {
          plant_id: input.plantId,
          line_code: input.groupCode,
          line_name: input.groupName,
          line_type_code: input.groupTypeCode,
          ...optional('parent_line_id', input.parentGroupId),
        },
      }),
    );
  }

  async update(
    equipmentGroupId: number,
    version: number,
    input: EquipmentGroupUpdate,
  ): Promise<EquipmentGroupResult> {
    await this.assertGroupType(input.groupTypeCode);
    const current = await this.prisma.production_line.findUnique({
      where: { production_line_id: equipmentGroupId },
      select: { plant_id: true },
    });
    if (!current) throw new NotFoundException('없는 설비 그룹입니다.');
    if (input.parentGroupId != null) {
      await this.assertParent(Number(current.plant_id), input.parentGroupId, equipmentGroupId);
    }

    const updated = await this.prisma.production_line.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { production_line_id: equipmentGroupId, version_no: version },
      data: {
        line_name: input.groupName,
        line_type_code: input.groupTypeCode,
        ...optional('line_code', input.groupCode),
        ...optional('parent_line_id', input.parentGroupId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(equipmentGroupId, updated.count);
    return this.get(equipmentGroupId);
  }

  async setActive(
    equipmentGroupId: number,
    version: number,
    isActive: boolean,
  ): Promise<EquipmentGroupResult> {
    const updated = await this.prisma.production_line.updateMany({
      where: { production_line_id: equipmentGroupId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(equipmentGroupId, updated.count);
    return this.get(equipmentGroupId);
  }

  private assertGroupType(groupTypeCode: string): Promise<void> {
    // 계약은 「값 목록이 확정되지 않았다」로 적었으나 시드에 LINE_TYPE(LINE·WORK_AREA)이
    // 있다. 그 그룹으로 대조한다 — 되돌림 문서에 적었다.
    return assertCodeValues(this.prisma, [
      { field: 'groupTypeCode', value: groupTypeCode, groupCode: 'LINE_TYPE' },
    ]);
  }

  /**
   * 상위 그룹을 검사한다. `production_line` 에는 자기 자신을 막는 CHECK 조차 없다 —
   * 위치(#117)와 같은 자리다. 공장이 같아야 한다는 것도 서버가 정했다: 목록이 공장으로
   * 걸리고 코드 유일 범위도 공장 안이므로, 공장을 넘는 자식은 어느 화면에도 안 보인다.
   */
  private async assertParent(
    plantId: number,
    parentId: number,
    selfId: number | null,
  ): Promise<void> {
    if (selfId !== null && parentId === selfId) {
      throw parentError('자기 자신을 상위 그룹으로 둘 수 없습니다.');
    }

    const seen = new Set<number>(selfId === null ? [] : [selfId]);
    let current: number | null = parentId;
    while (current !== null) {
      if (seen.has(current)) {
        throw parentError('상위 그룹으로 지정하면 그룹 계층에 순환이 생깁니다.');
      }
      seen.add(current);

      const row: { plant_id: bigint; parent_line_id: bigint | null } | null =
        await this.prisma.production_line.findUnique({
          where: { production_line_id: current },
          select: { plant_id: true, parent_line_id: true },
        });
      if (row === null) throw parentError('없는 설비 그룹입니다.');
      if (Number(row.plant_id) !== plantId) throw parentError('다른 공장의 그룹입니다.');

      current = row.parent_line_id === null ? null : Number(row.parent_line_id);
    }
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(equipmentGroupId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.production_line.findUnique({
      where: { production_line_id: equipmentGroupId },
      select: { production_line_id: true },
    });
    if (!exists) throw new NotFoundException('없는 설비 그룹입니다.');
    assertUpdated(0);
  }
}

function parentError(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'parentGroupId', code: ERROR_CODE.INVALID, message },
  ]);
}

function view(row: LineRow): EquipmentGroupView {
  return {
    equipmentGroupId: Number(row.production_line_id),
    plantId: Number(row.plant_id),
    groupCode: row.line_code,
    groupName: row.line_name,
    groupTypeCode: row.line_type_code,
    parentGroupId: row.parent_line_id === null ? null : Number(row.parent_line_id),
    isActive: row.is_active,
  };
}
