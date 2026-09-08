import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, Referrer, assertCodeValues, countReferences, optional, referencePage, referenceWhere, toDateString } from '../../common/master';

/** 설비를 FK 로 가리키는 자리 전부 — 스물한 곳이다. e2e 가 `pg_constraint` 로 대조한다. */
export const EQUIPMENT_REFERRERS: readonly Referrer[] = [
  ['maintenance.breakdown', 'equipment_id'],
  ['maintenance.collection_channel', 'equipment_id'],
  ['maintenance.equipment_downtime', 'equipment_id'],
  ['maintenance.equipment_inspection', 'equipment_id'],
  ['maintenance.maintenance_order', 'equipment_id'],
  ['maintenance.maintenance_result', 'equipment_id'],
  ['maintenance.planned_stop', 'equipment_id'],
  ['maintenance.tool_usage', 'equipment_id'],
  ['mdm.equipment_group_member', 'equipment_id'],
  ['mdm.equipment_inspection_item_assignment', 'equipment_id'],
  ['mdm.spare_part_equipment', 'equipment_id'],
  ['mdm.terminal', 'equipment_id'],
  ['production.precheck_decision', 'equipment_id'],
  ['production.production_result', 'equipment_id'],
  ['production.work_order', 'planned_equipment_id'],
  ['production.work_order_resource_assignment', 'equipment_id'],
  ['production.work_session', 'equipment_id'],
  ['quality.defect_record', 'equipment_id'],
  ['quality.equipment_calibration', 'equipment_id'],
  ['quality.inspection_item_spec', 'default_inspection_equipment_id'],
  ['quality.inspection_measurement', 'inspection_equipment_id'],
];

/** 자산 폐기는 사용 중지와 «다른 축»이다 — 공유계약 `B-16`. */
const STATUS_COLUMN = 'mdm.equipment.status_code';
const DISPOSED = 'DISPOSED';

/** 계약 `Equipment` 와 동형. */
interface EquipmentView {
  equipmentId: number;
  plantId: number;
  equipmentCode: string;
  equipmentName: string;
  equipmentTypeCode: string;
  locationId: number | null;
  processId: number | null;
  productionLineId: number | null;
  statusCode: string;
  calibrationRequired: boolean;
  lastCalibrationDate: string | null;
  calibrationDueDate: string | null;
  isActive: boolean;
  calibrationCycleTypeCode: string | null;
  calibrationCycleInterval: number | null;
  precisionValue: number | null;
  precisionUomId: number | null;
}

/** 계약 `EquipmentHierarchy` — 「공장 > 상위 그룹 > 하위 그룹 > 설비」의 재료. */
interface Hierarchy {
  plantName: string;
  groupNames: string[];
  equipmentName: string;
  groupAssigned: boolean;
}

export interface EquipmentWrite {
  equipmentCode?: string;
  equipmentName: string;
  equipmentTypeCode: string;
  productionLineId?: number | null;
  processId?: number | null;
  calibrationRequired: boolean;
  calibrationCycleTypeCode?: string | null;
  calibrationCycleInterval?: number | null;
  precisionValue?: number | null;
  precisionUomId?: number | null;
}

export interface EquipmentCreate extends EquipmentWrite {
  plantId: number;
  equipmentCode: string;
}

export interface EquipmentQuery extends ReferenceQuery {
  plantId?: number;
  processId?: number;
  productionLineId?: number;
  equipmentTypeCode?: string;
  calibrationRequired?: boolean;
  statusCode?: string;
}

type EquipmentRow = Prisma.equipmentGetPayload<object>;

export type EquipmentResult = {
  equipment: EquipmentView;
  editability: Editability;
  hierarchy: Hierarchy;
  versionNo: number;
};

@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
  ) {}

  async list(query: EquipmentQuery): Promise<PagedResponse<EquipmentView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'equipment_code', name: 'equipment_name' }, {
      ...optional('plant_id', query.plantId),
      ...optional('process_id', query.processId),
      ...optional('production_line_id', query.productionLineId),
      ...optional('equipment_type_code', query.equipmentTypeCode),
      ...optional('calibration_required', query.calibrationRequired),
      ...optional('status_code', query.statusCode),
    });
    const [rows, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        // 코드는 공장 안에서만 유일하다(uq_equipment) — 공장을 앞세운다.
        orderBy: [{ plant_id: 'asc' }, { equipment_code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.equipment.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(equipmentId: number): Promise<EquipmentResult> {
    const row = await this.prisma.equipment.findUnique({ where: { equipment_id: equipmentId } });
    if (!row) throw new NotFoundException('없는 설비입니다.');

    const [referenceCount, hierarchy] = await Promise.all([
      countReferences(this.prisma, EQUIPMENT_REFERRERS, row.equipment_id),
      this.hierarchy(row),
    ]);
    return {
      equipment: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      hierarchy,
      versionNo: row.version_no,
    };
  }

  async create(input: EquipmentCreate): Promise<EquipmentView> {
    await this.assertWritable(input);
    return view(
      await this.prisma.equipment.create({
        data: {
          plant_id: input.plantId,
          equipment_code: input.equipmentCode,
          equipment_name: input.equipmentName,
          equipment_type_code: input.equipmentTypeCode,
          calibration_required: input.calibrationRequired,
          // 새 설비는 운용 중이다 — 폐기는 `:dispose` 로만 간다(B-16).
          status_code: 'IN_SERVICE',
          ...optional('production_line_id', input.productionLineId),
          ...optional('process_id', input.processId),
          ...optional('calibration_cycle_type_code', input.calibrationCycleTypeCode),
          ...optional('calibration_cycle_interval', input.calibrationCycleInterval),
          ...optional('precision_value', input.precisionValue),
          ...optional('precision_uom_id', input.precisionUomId),
        },
      }),
    );
  }

  async update(
    equipmentId: number,
    version: number,
    input: EquipmentWrite,
  ): Promise<EquipmentResult> {
    await this.assertWritable(input);
    await this.assertNotDisposed(equipmentId);

    const updated = await this.prisma.equipment.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { equipment_id: equipmentId, version_no: version },
      data: {
        equipment_name: input.equipmentName,
        equipment_type_code: input.equipmentTypeCode,
        calibration_required: input.calibrationRequired,
        ...optional('equipment_code', input.equipmentCode),
        ...optional('production_line_id', input.productionLineId),
        ...optional('process_id', input.processId),
        ...optional('calibration_cycle_type_code', input.calibrationCycleTypeCode),
        ...optional('calibration_cycle_interval', input.calibrationCycleInterval),
        ...optional('precision_value', input.precisionValue),
        ...optional('precision_uom_id', input.precisionUomId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(equipmentId, updated.count);
    return this.get(equipmentId);
  }

  async setActive(
    equipmentId: number,
    version: number,
    isActive: boolean,
  ): Promise<EquipmentResult> {
    const updated = await this.prisma.equipment.updateMany({
      where: { equipment_id: equipmentId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(equipmentId, updated.count);
    return this.get(equipmentId);
  }

  /**
   * 자산을 폐기한다. 사용 중지와 «다른 축»이다 — 중지는 목록에서 감추는 것이고 폐기는
   * 자산이 끝난 것이다(B-16). 전이는 상태기계 코어가 가른다.
   */
  async dispose(equipmentId: number, version: number): Promise<EquipmentResult> {
    const current = await this.prisma.equipment.findUnique({
      where: { equipment_id: equipmentId },
      select: { status_code: true },
    });
    if (!current) throw new NotFoundException('없는 설비입니다.');
    const transition = this.documentState.assertTransition(
      STATUS_COLUMN,
      'equipment-dispose',
      current.status_code,
    );

    const updated = await this.prisma.equipment.updateMany({
      where: { equipment_id: equipmentId, version_no: version },
      data: { status_code: transition.to, version_no: { increment: 1 } },
    });
    await this.assertExists(equipmentId, updated.count);
    return this.get(equipmentId);
  }

  /**
   * 계층 텍스트의 재료. 그룹은 나무라 최상위부터 차례로 담는다 — 화면이
   * 「공장 > 상위 그룹 > 하위 그룹 > 설비」로 잇는다(W-05-12 §5-3 · DR-004).
   */
  private async hierarchy(row: EquipmentRow): Promise<Hierarchy> {
    const plant = await this.prisma.plant.findUnique({
      where: { plant_id: row.plant_id },
      select: { plant_name: true },
    });

    const names: string[] = [];
    const seen = new Set<number>();
    let groupId = row.production_line_id === null ? null : Number(row.production_line_id);
    while (groupId !== null && !seen.has(groupId)) {
      seen.add(groupId);
      const group: { line_name: string; parent_line_id: bigint | null } | null =
        await this.prisma.production_line.findUnique({
          where: { production_line_id: groupId },
          select: { line_name: true, parent_line_id: true },
        });
      if (group === null) break;
      names.unshift(group.line_name);
      groupId = group.parent_line_id === null ? null : Number(group.parent_line_id);
    }

    return {
      plantName: plant?.plant_name ?? '',
      groupNames: names,
      equipmentName: row.equipment_name,
      // 「거짓이면 계층이 공장까지만 나온다. 화면은 빈칸이 아니라 «소속 그룹 없음»으로
      // 밝힌다」(계약) — 그래서 빈 배열과 별개의 칸이 필요하다.
      groupAssigned: row.production_line_id !== null,
    };
  }

  private async assertWritable(input: EquipmentWrite): Promise<void> {
    // ⛔ 계약 — 「calibrationRequired 가 참이면 주기 두 칸이 함께 필요하다.
    // 주기 없이는 차기 예정일을 산출할 수 없다」. 주기 없이 참으로 두면 검교정 대상인데
    // 언제 해야 하는지 아무도 모르는 설비가 생긴다.
    const errors: ErrorItem[] = [];
    if (input.calibrationRequired) {
      if (input.calibrationCycleTypeCode == null) {
        errors.push(required('calibrationCycleTypeCode'));
      }
      if (input.calibrationCycleInterval == null) {
        errors.push(required('calibrationCycleInterval'));
      }
    }
    if ((input.precisionValue == null) !== (input.precisionUomId == null)) {
      errors.push({
        scope: 'field',
        field: input.precisionValue == null ? 'precisionValue' : 'precisionUomId',
        code: ERROR_CODE.PAIR,
        message: '정밀도 수치와 단위는 함께 넣거나 함께 비웁니다.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, [
      // ⚠ 설비 «유형»은 계열마다 그룹이 다르다(계약). 지금은 설비 계열의 EQUIPMENT_TYPE
      // 으로만 본다 — 계측기 계열(INSTRUMENT_TYPE)이 서면 그때 가른다. 되돌림 문서에 적었다.
      {
        field: 'equipmentTypeCode',
        value: input.equipmentTypeCode,
        groupCode: 'EQUIPMENT_TYPE',
      },
      {
        field: 'calibrationCycleTypeCode',
        value: input.calibrationCycleTypeCode,
        groupCode: 'CYCLE_TYPE',
      },
    ]);
  }

  /** 「폐기된 뒤에는 다시 불러와도 편집이 풀리지 않는다」(계약 · B-16). */
  private async assertNotDisposed(equipmentId: number): Promise<void> {
    const row = await this.prisma.equipment.findUnique({
      where: { equipment_id: equipmentId },
      select: { status_code: true },
    });
    if (!row) throw new NotFoundException('없는 설비입니다.');
    if (row.status_code !== DISPOSED) return;
    // ⛔ 400 이다 — 계약이 이 오퍼레이션의 409 설명에 「업무 규칙 위반(상태 잠김·참조
    // 존재)은 409 가 아니라 400 이다」로 적었다. 409 는 저장 충돌 전용이다.
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        // ⛔ 재로드해도 풀리지 않는다 — 저장 충돌과 구분한다(G-1).
        code: ERROR_CODE.STATE_LOCKED,
        message: '폐기한 설비는 수정할 수 없습니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(equipmentId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.equipment.findUnique({
      where: { equipment_id: equipmentId },
      select: { equipment_id: true },
    });
    if (!exists) throw new NotFoundException('없는 설비입니다.');
    assertUpdated(0);
  }
}

function required(field: string): ErrorItem {
  return {
    scope: 'field',
    field,
    code: ERROR_CODE.REQUIRED,
    message: '검교정 대상 설비는 주기를 함께 넣습니다.',
  };
}

function view(row: EquipmentRow): EquipmentView {
  return {
    equipmentId: Number(row.equipment_id),
    plantId: Number(row.plant_id),
    equipmentCode: row.equipment_code,
    equipmentName: row.equipment_name,
    equipmentTypeCode: row.equipment_type_code,
    locationId: row.location_id === null ? null : Number(row.location_id),
    processId: row.process_id === null ? null : Number(row.process_id),
    productionLineId: row.production_line_id === null ? null : Number(row.production_line_id),
    statusCode: row.status_code,
    calibrationRequired: row.calibration_required,
    lastCalibrationDate: toDateString(row.last_calibration_date),
    calibrationDueDate: toDateString(row.calibration_due_date),
    isActive: row.is_active,
    calibrationCycleTypeCode: row.calibration_cycle_type_code,
    calibrationCycleInterval: row.calibration_cycle_interval,
    precisionValue: row.precision_value === null ? null : Number(row.precision_value),
    precisionUomId: row.precision_uom_id === null ? null : Number(row.precision_uom_id),
  };
}
