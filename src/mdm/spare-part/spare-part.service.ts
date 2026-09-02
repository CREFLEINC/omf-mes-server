import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, Referrer, countReferences, optional, referencePage, referenceWhere } from '../../common/master';

/** 예비품을 FK 로 가리키는 자리. e2e 가 `pg_constraint` 로 대조한다. */
export const SPARE_PART_REFERRERS: readonly Referrer[] = [
  ['logistics.goods_issue_spare_line', 'spare_part_id'],
  ['mdm.spare_part_equipment', 'spare_part_id'],
];

/** 계약 `SparePart` 와 동형 — 다섯 칸뿐이다. */
interface SparePartView {
  sparePartId: number;
  plantId: number;
  sparePartCode: string;
  sparePartName: string;
  isActive: boolean;
}

/** 계약 `SparePartEquipmentMapping` — 설비 코드·명을 함께 낸다. */
interface MappingView {
  equipmentId: number;
  equipmentCode: string;
  equipmentName: string;
}

export interface SparePartCreate {
  plantId: number;
  sparePartCode: string;
  sparePartName: string;
}

export interface SparePartUpdate {
  sparePartCode?: string;
  sparePartName: string;
}

export interface SparePartQuery extends ReferenceQuery {
  plantId?: number;
  equipmentId?: number;
}

type SparePartRow = Prisma.spare_partGetPayload<object>;

export type SparePartResult = {
  sparePart: SparePartView;
  editability: Editability;
  mappedEquipmentCount: number;
  versionNo: number;
};

@Injectable()
export class SparePartService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SparePartQuery): Promise<PagedResponse<SparePartView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'spare_part_code', name: 'spare_part_name' }, {
      ...optional('plant_id', query.plantId),
      // 「이 설비에 쓰는 예비품」을 고르는 자리다 — 매핑을 타고 거른다.
      ...(query.equipmentId === undefined
        ? {}
        : { spare_part_equipment: { some: { equipment_id: query.equipmentId } } }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.spare_part.findMany({
        where,
        // 코드는 공장 안에서만 유일하다(uq_spare_part) — 공장을 앞세운다.
        orderBy: [{ plant_id: 'asc' }, { spare_part_code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.spare_part.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(sparePartId: number): Promise<SparePartResult> {
    const row = await this.prisma.spare_part.findUnique({
      where: { spare_part_id: sparePartId },
    });
    if (!row) throw new NotFoundException('없는 예비품입니다.');

    const [referenceCount, mappedEquipmentCount] = await Promise.all([
      countReferences(this.prisma, SPARE_PART_REFERRERS, row.spare_part_id),
      this.prisma.spare_part_equipment.count({ where: { spare_part_id: row.spare_part_id } }),
    ]);
    return {
      sparePart: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      mappedEquipmentCount,
      versionNo: row.version_no,
    };
  }

  async create(input: SparePartCreate): Promise<SparePartView> {
    return view(
      await this.prisma.spare_part.create({
        data: {
          plant_id: input.plantId,
          spare_part_code: input.sparePartCode,
          spare_part_name: input.sparePartName,
        },
      }),
    );
  }

  async update(
    sparePartId: number,
    version: number,
    input: SparePartUpdate,
  ): Promise<SparePartResult> {
    const updated = await this.prisma.spare_part.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { spare_part_id: sparePartId, version_no: version },
      data: {
        spare_part_name: input.sparePartName,
        ...optional('spare_part_code', input.sparePartCode),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(sparePartId, updated.count);
    return this.get(sparePartId);
  }

  async setActive(
    sparePartId: number,
    version: number,
    isActive: boolean,
  ): Promise<SparePartResult> {
    const updated = await this.prisma.spare_part.updateMany({
      where: { spare_part_id: sparePartId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(sparePartId, updated.count);
    return this.get(sparePartId);
  }

  // ── 설비 매핑 ───────────────────────────────────────────────────────────

  async listMappings(sparePartId: number): Promise<{ items: MappingView[]; versionNo: number }> {
    const { versionNo } = await this.get(sparePartId);
    return { items: await this.readMappings(sparePartId), versionNo };
  }

  /**
   * 「묶음을 통째로 교체한다」(계약 · G-30). 잠금 축은 예비품의 `version_no` 다 —
   * `spare_part_equipment` 에 자기 버전이 없다.
   */
  async replaceMappings(
    sparePartId: number,
    version: number,
    equipmentIds: number[],
    appUserId?: number,
  ): Promise<{ items: MappingView[]; versionNo: number }> {
    await this.assertEquipmentIds(sparePartId, equipmentIds);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.spare_part.updateMany({
        where: { spare_part_id: sparePartId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.spare_part.findUnique({
          where: { spare_part_id: sparePartId },
          select: { spare_part_id: true },
        });
        if (!exists) throw new NotFoundException('없는 예비품입니다.');
        assertUpdated(0);
      }

      await tx.spare_part_equipment.deleteMany({ where: { spare_part_id: sparePartId } });
      if (equipmentIds.length === 0) return;
      await tx.spare_part_equipment.createMany({
        data: equipmentIds.map((equipmentId) => ({
          spare_part_id: sparePartId,
          equipment_id: equipmentId,
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });

    return this.listMappings(sparePartId);
  }

  private async readMappings(sparePartId: number): Promise<MappingView[]> {
    const rows = await this.prisma.spare_part_equipment.findMany({
      where: { spare_part_id: sparePartId },
      include: { equipment: { select: { equipment_code: true, equipment_name: true } } },
    });
    return rows
      .map((row) => ({
        equipmentId: Number(row.equipment_id),
        equipmentCode: row.equipment.equipment_code,
        equipmentName: row.equipment.equipment_name,
      }))
      .sort((a, b) => a.equipmentCode.localeCompare(b.equipmentCode));
  }

  /**
   * 중복과 「이 공장의 설비인가」를 본다. 예비품이 공장 단위이므로 다른 공장의 설비를
   * 매핑하면 어느 목록에서도 짝이 맞지 않는다 — 계약에 없고 서버가 정했다.
   */
  private async assertEquipmentIds(sparePartId: number, equipmentIds: number[]): Promise<void> {
    const errors: ErrorItem[] = [];
    const seen = new Map<number, number>();
    equipmentIds.forEach((equipmentId, index) => {
      const first = seen.get(equipmentId);
      if (first === undefined) {
        seen.set(equipmentId, index);
        return;
      }
      errors.push({
        scope: 'field',
        field: `equipmentIds[${index}]`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['equipmentId'],
        message: `${first + 1}번째와 같은 설비입니다.`,
      });
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (seen.size === 0) return;

    const owner = await this.prisma.spare_part.findUnique({
      where: { spare_part_id: sparePartId },
      select: { plant_id: true },
    });
    if (!owner) throw new NotFoundException('없는 예비품입니다.');

    const known = await this.prisma.equipment.findMany({
      where: { plant_id: owner.plant_id, equipment_id: { in: [...seen.keys()] } },
      select: { equipment_id: true },
    });
    const knownIds = new Set(known.map((row) => Number(row.equipment_id)));
    for (const [equipmentId, index] of seen) {
      if (knownIds.has(equipmentId)) continue;
      errors.push({
        scope: 'field',
        field: `equipmentIds[${index}]`,
        code: ERROR_CODE.INVALID,
        message: '이 공장의 설비가 아닙니다.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(sparePartId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.spare_part.findUnique({
      where: { spare_part_id: sparePartId },
      select: { spare_part_id: true },
    });
    if (!exists) throw new NotFoundException('없는 예비품입니다.');
    assertUpdated(0);
  }
}

function view(row: SparePartRow): SparePartView {
  return {
    sparePartId: Number(row.spare_part_id),
    plantId: Number(row.plant_id),
    sparePartCode: row.spare_part_code,
    sparePartName: row.spare_part_name,
    isActive: row.is_active,
  };
}
