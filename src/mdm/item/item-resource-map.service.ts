import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `ItemResourceMap` 과 동형. 이름 칸은 화면이 목록마다 따로 풀지 않게 함께 싣는다. */
export interface ItemResourceMapView {
  itemResourceMapId: number;
  plantId: number;
  itemId: number;
  processId: number | null;
  processCode: string | null;
  processName: string | null;
  equipmentId: number | null;
  equipmentCode: string | null;
  equipmentName: string | null;
  /** 설비의 라인 — 계획에 라인이 없을 때 W/O 라인을 여기서 얻는다. */
  productionLineId: number | null;
  moldId: number | null;
  moldCode: string | null;
  moldName: string | null;
  isDefault: boolean;
  priorityNo: number;
  isActive: boolean;
  remarks: string | null;
  /** 행마다 수정하므로 목록에서 바로 If-Match 를 만들 수 있게 싣는다. */
  versionNo: number;
}

export interface ItemResourceMapCreate {
  plantId: number;
  itemId: number;
  processId?: number | null;
  equipmentId?: number | null;
  moldId?: number | null;
  isDefault?: boolean;
  priorityNo?: number;
  remarks?: string | null;
}

/** 생략 = 유지, null = 비움. 공장·품목은 바꾸지 않는다 — 다른 품목이면 새로 등록한다. */
export interface ItemResourceMapUpdate {
  processId?: number | null;
  equipmentId?: number | null;
  moldId?: number | null;
  isDefault?: boolean;
  priorityNo?: number;
  isActive?: boolean;
  remarks?: string | null;
}

export interface ItemResourceMapQuery {
  plantId?: number;
  itemId?: number;
  equipmentId?: number;
  moldId?: number;
  includeInactive?: boolean;
}

const INCLUDE = {
  process: { select: { process_code: true, process_name: true } },
  equipment: { select: { equipment_code: true, equipment_name: true, production_line_id: true } },
  mold: { select: { mold_code: true, mold_name: true } },
} as const;

type MapRow = Prisma.item_resource_mapGetPayload<{ include: typeof INCLUDE }>;

interface Target {
  plantId: bigint;
  itemId: bigint;
  processId: bigint | null;
  equipmentId: bigint | null;
  moldId: bigint | null;
}

const idOf = (value: number | null | undefined): bigint | null | undefined =>
  value === undefined ? undefined : value === null ? null : BigInt(value);

@Injectable()
export class ItemResourceMapService {
  constructor(private readonly prisma: PrismaService) {}

  /** 기본이 먼저, 그다음 우선순위 — 추천과 자동 배정이 읽는 순서와 같다. */
  async list(query: ItemResourceMapQuery): Promise<{ items: ItemResourceMapView[] }> {
    const rows = await this.prisma.item_resource_map.findMany({
      where: {
        ...(query.plantId === undefined ? {} : { plant_id: query.plantId }),
        ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
        ...(query.equipmentId === undefined ? {} : { equipment_id: query.equipmentId }),
        ...(query.moldId === undefined ? {} : { mold_id: query.moldId }),
        ...(query.includeInactive ? {} : { is_active: true }),
      },
      include: INCLUDE,
      orderBy: [{ is_default: 'desc' }, { priority_no: 'asc' }, { item_resource_map_id: 'asc' }],
    });
    return { items: rows.map(view) };
  }

  async get(id: number): Promise<{ itemResourceMap: ItemResourceMapView; versionNo: number }> {
    const row = await this.prisma.item_resource_map.findUnique({
      where: { item_resource_map_id: id },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('없는 설비·금형 매핑입니다.');
    return { itemResourceMap: view(row), versionNo: row.version_no };
  }

  async create(input: ItemResourceMapCreate, appUserId: number | undefined): Promise<ItemResourceMapView> {
    const target: Target = {
      plantId: BigInt(input.plantId),
      itemId: BigInt(input.itemId),
      processId: idOf(input.processId) ?? null,
      equipmentId: idOf(input.equipmentId) ?? null,
      moldId: idOf(input.moldId) ?? null,
    };
    await this.assertTarget(target, true);
    const id = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault === true) await demoteDefault(tx, target, null);
      const created = await tx.item_resource_map.create({
        data: {
          plant_id: target.plantId,
          item_id: target.itemId,
          process_id: target.processId,
          equipment_id: target.equipmentId,
          mold_id: target.moldId,
          is_default: input.isDefault ?? false,
          priority_no: input.priorityNo ?? 100,
          remarks: input.remarks ?? null,
          created_by: appUserId ?? null,
          updated_by: appUserId ?? null,
        },
        select: { item_resource_map_id: true },
      });
      return created.item_resource_map_id;
    }).catch(rethrowDuplicate);
    return (await this.get(Number(id))).itemResourceMap;
  }

  async update(
    id: number,
    version: number,
    input: ItemResourceMapUpdate,
    appUserId: number | undefined,
  ): Promise<{ itemResourceMap: ItemResourceMapView; versionNo: number }> {
    const current = await this.prisma.item_resource_map.findUnique({ where: { item_resource_map_id: id } });
    if (!current) throw new NotFoundException('없는 설비·금형 매핑입니다.');
    const target: Target = {
      plantId: current.plant_id,
      itemId: current.item_id,
      processId: input.processId === undefined ? current.process_id : (idOf(input.processId) ?? null),
      equipmentId: input.equipmentId === undefined ? current.equipment_id : (idOf(input.equipmentId) ?? null),
      moldId: input.moldId === undefined ? current.mold_id : (idOf(input.moldId) ?? null),
    };
    await this.assertTarget(target, false);
    const becomesDefault = (input.isDefault ?? current.is_default) && (input.isActive ?? current.is_active);

    await this.prisma.$transaction(async (tx) => {
      if (becomesDefault) await demoteDefault(tx, target, current.item_resource_map_id);
      const updated = await tx.item_resource_map.updateMany({
        // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
        where: { item_resource_map_id: id, version_no: version },
        data: {
          process_id: target.processId,
          equipment_id: target.equipmentId,
          mold_id: target.moldId,
          ...(input.isDefault === undefined ? {} : { is_default: input.isDefault }),
          ...(input.priorityNo === undefined ? {} : { priority_no: input.priorityNo }),
          ...(input.isActive === undefined ? {} : { is_active: input.isActive }),
          ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
          updated_by: appUserId ?? null,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count);
    }).catch(rethrowDuplicate);
    return this.get(id);
  }

  /** 설비·금형은 그 공장의 것이어야 한다 — 다른 공장 설비로 W/O 가 배정되면 단말 권한·재고가 공장을 넘는다. */
  private async assertTarget(target: Target, checkItem: boolean): Promise<void> {
    const errors: ErrorItem[] = [];
    if (target.equipmentId === null && target.moldId === null) {
      errors.push(fieldError('equipmentId', ERROR_CODE.REQUIRED, '설비나 금형 중 하나는 있어야 합니다.'));
    }
    const [item, process, equipment, mold] = await Promise.all([
      checkItem ? this.prisma.item.findUnique({ where: { item_id: target.itemId }, select: { item_id: true } }) : true,
      target.processId === null ? true : this.prisma.process.findUnique({ where: { process_id: target.processId }, select: { process_id: true } }),
      target.equipmentId === null ? null : this.prisma.equipment.findUnique({ where: { equipment_id: target.equipmentId }, select: { plant_id: true } }),
      target.moldId === null ? null : this.prisma.mold.findUnique({ where: { mold_id: target.moldId }, select: { plant_id: true } }),
    ]);
    if (!item) errors.push(fieldError('itemId', ERROR_CODE.INVALID, '없는 품목입니다.'));
    if (!process) errors.push(fieldError('processId', ERROR_CODE.INVALID, '없는 공정입니다.'));
    if (target.equipmentId !== null && equipment?.plant_id !== target.plantId) {
      errors.push(fieldError('equipmentId', ERROR_CODE.INVALID, '이 공장의 설비가 아닙니다.'));
    }
    if (target.moldId !== null && mold?.plant_id !== target.plantId) {
      errors.push(fieldError('moldId', ERROR_CODE.INVALID, '이 공장의 금형이 아닙니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

/** 기본은 품목·공정마다 하나다 — 새 기본을 세우기 전에 같은 자리의 기본을 내린다. */
async function demoteDefault(tx: Prisma.TransactionClient, target: Target, exceptId: bigint | null): Promise<void> {
  await tx.item_resource_map.updateMany({
    where: {
      plant_id: target.plantId,
      item_id: target.itemId,
      process_id: target.processId,
      is_default: true,
      ...(exceptId === null ? {} : { item_resource_map_id: { not: exceptId } }),
    },
    data: { is_default: false, version_no: { increment: 1 } },
  });
}

function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      fieldError('moldId', ERROR_CODE.UNIQUE_VIOLATION, '같은 품목·공정·설비·금형 매핑이 이미 있습니다.'),
    ]);
  }
  throw error;
}

function fieldError(field: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field, code, message };
}

const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

function view(row: MapRow): ItemResourceMapView {
  return {
    itemResourceMapId: Number(row.item_resource_map_id),
    plantId: Number(row.plant_id),
    itemId: Number(row.item_id),
    processId: num(row.process_id),
    processCode: row.process?.process_code ?? null,
    processName: row.process?.process_name ?? null,
    equipmentId: num(row.equipment_id),
    equipmentCode: row.equipment?.equipment_code ?? null,
    equipmentName: row.equipment?.equipment_name ?? null,
    productionLineId: num(row.equipment?.production_line_id ?? null),
    moldId: num(row.mold_id),
    moldCode: row.mold?.mold_code ?? null,
    moldName: row.mold?.mold_name ?? null,
    isDefault: row.is_default,
    priorityNo: row.priority_no,
    isActive: row.is_active,
    remarks: row.remarks,
    versionNo: row.version_no,
  };
}
