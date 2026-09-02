import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertCodeValues } from '../code-reference';
import { Editability, ReferenceQuery, optional, referencePage, referenceWhere } from '../../common/master';

/** 계약 `EquipmentInspectionItem` 과 동형. */
interface InspectionItemView {
  equipmentInspectionItemId: number;
  plantId: number;
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
}

export interface InspectionItemCreate {
  plantId: number;
  itemCode: string;
  itemName: string;
  inspectionTypeCode: string;
  judgmentMethodCode: string;
  uomId?: number | null;
  lowerLimit?: number | null;
  upperLimit?: number | null;
  requiredFlag: boolean;
  inspectionPoint?: string | null;
  sequenceNo: number;
}

export interface InspectionItemUpdate extends Omit<InspectionItemCreate, 'plantId'> {
  isActive: boolean;
}

export interface InspectionItemQuery extends ReferenceQuery {
  plantId?: number;
  inspectionTypeCode?: string;
}

type InspectionItemRow = Prisma.equipment_inspection_itemGetPayload<object>;

export type InspectionItemResult = {
  equipmentInspectionItem: InspectionItemView;
  editability: Editability;
  assignmentCount: number;
  versionNo: number;
};

/** 측정값 판정이면 단위·상하한이 있어야 한다 — 계약이 못박았다. */
const MEASUREMENT = 'MEASUREMENT';

@Injectable()
export class InspectionItemService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionItemQuery): Promise<PagedResponse<InspectionItemView>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'inspection_item_code', name: 'inspection_item_name' },
      {
        ...optional('plant_id', query.plantId),
        ...optional('inspection_type_code', query.inspectionTypeCode),
      },
    );
    const [rows, total] = await Promise.all([
      this.prisma.equipment_inspection_item.findMany({
        where,
        // 표시 순서가 이 마스터의 뜻이다 — 점검 화면이 이 차례로 그린다.
        orderBy: [{ sequence_no: 'asc' }, { inspection_item_code: 'asc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.equipment_inspection_item.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(equipmentInspectionItemId: number): Promise<InspectionItemResult> {
    const row = await this.prisma.equipment_inspection_item.findUnique({
      where: { equipment_inspection_item_id: equipmentInspectionItemId },
    });
    if (!row) throw new NotFoundException('없는 점검항목입니다.');

    const assignmentCount = await this.assignmentCount(row.equipment_inspection_item_id);
    return {
      equipmentInspectionItem: view(row),
      // 「코드 수정 가부와 사유를 응답이 함께 내린다 — 화면이 따로 세지 않는다」(계약).
      editability: {
        codeEditable: assignmentCount === 0,
        reason: assignmentCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount: assignmentCount,
      },
      assignmentCount,
      versionNo: row.version_no,
    };
  }

  async create(input: InspectionItemCreate): Promise<InspectionItemView> {
    await this.assertWritable(input);
    return view(
      await this.prisma.equipment_inspection_item.create({
        data: {
          plant_id: input.plantId,
          inspection_item_code: input.itemCode,
          inspection_item_name: input.itemName,
          inspection_type_code: input.inspectionTypeCode,
          judgment_method_code: input.judgmentMethodCode,
          data_type_code: dataTypeOf(input.judgmentMethodCode),
          is_required: input.requiredFlag,
          sequence_no: input.sequenceNo,
          ...optional('uom_id', input.uomId),
          ...optional('lower_limit', input.lowerLimit),
          ...optional('upper_limit', input.upperLimit),
          ...optional('inspection_point', input.inspectionPoint),
        },
      }),
    );
  }

  async update(
    equipmentInspectionItemId: number,
    version: number,
    input: InspectionItemUpdate,
  ): Promise<InspectionItemResult> {
    await this.assertWritable(input);
    const updated = await this.prisma.equipment_inspection_item.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { equipment_inspection_item_id: equipmentInspectionItemId, version_no: version },
      data: {
        inspection_item_name: input.itemName,
        inspection_type_code: input.inspectionTypeCode,
        judgment_method_code: input.judgmentMethodCode,
        data_type_code: dataTypeOf(input.judgmentMethodCode),
        is_required: input.requiredFlag,
        sequence_no: input.sequenceNo,
        is_active: input.isActive,
        ...optional('inspection_item_code', input.itemCode),
        ...optional('uom_id', input.uomId),
        ...optional('lower_limit', input.lowerLimit),
        ...optional('upper_limit', input.upperLimit),
        ...optional('inspection_point', input.inspectionPoint),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(equipmentInspectionItemId, updated.count);
    return this.get(equipmentInspectionItemId);
  }

  /**
   * 이 항목이 설비·그룹에 부여된 건수. 둘은 별도 표라 함께 센다 — 화면은 「부여된 곳이
   * 있는가」만 알면 되고, 어느 쪽인지는 묻지 않는다.
   */
  private async assignmentCount(equipmentInspectionItemId: bigint): Promise<number> {
    const [byEquipment, byGroup] = await Promise.all([
      this.prisma.equipment_inspection_item_assignment.count({
        where: { equipment_inspection_item_id: equipmentInspectionItemId },
      }),
      this.prisma.equipment_group_inspection_item.count({
        where: { equipment_inspection_item_id: equipmentInspectionItemId },
      }),
    ]);
    return byEquipment + byGroup;
  }

  private async assertWritable(input: {
    inspectionTypeCode: string;
    judgmentMethodCode: string;
    uomId?: number | null;
    lowerLimit?: number | null;
    upperLimit?: number | null;
  }): Promise<void> {
    const errors: ErrorItem[] = [];

    // ⛔ 계약 — 「측정값이면 단위(uomId)·상하한(lowerLimit·upperLimit)이 필수」.
    // 없으면 현장이 숫자를 적어도 판정할 기준이 없다. 항목은 서 있는데 판정은 못 하는
    // 상태가 되고, 그것이 점검 완료를 막는다(requiredFlag 와 맞물린다).
    if (input.judgmentMethodCode === MEASUREMENT) {
      if (input.uomId == null) errors.push(required('uomId'));
      if (input.lowerLimit == null) errors.push(required('lowerLimit'));
      if (input.upperLimit == null) errors.push(required('upperLimit'));
    }
    // ck_equipment_inspection_limits — 둘 다 있으면 하한 ≤ 상한.
    if (
      input.lowerLimit != null &&
      input.upperLimit != null &&
      input.lowerLimit > input.upperLimit
    ) {
      errors.push({
        scope: 'field',
        field: 'upperLimit',
        code: ERROR_CODE.PAIR,
        message: '상한은 하한보다 작을 수 없습니다.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    await assertCodeValues(this.prisma, [
      {
        field: 'inspectionTypeCode',
        value: input.inspectionTypeCode,
        groupCode: 'EQUIPMENT_INSPECTION_TYPE',
      },
      {
        field: 'judgmentMethodCode',
        value: input.judgmentMethodCode,
        groupCode: 'EQUIPMENT_INSPECTION_JUDGMENT_METHOD',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(equipmentInspectionItemId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.equipment_inspection_item.findUnique({
      where: { equipment_inspection_item_id: equipmentInspectionItemId },
      select: { equipment_inspection_item_id: true },
    });
    if (!exists) throw new NotFoundException('없는 점검항목입니다.');
    assertUpdated(0);
  }
}

/**
 * 계약은 `data_type_code` 를 받지 않는다. 그런데 물리 컬럼이 NOT NULL 이라 무언가는
 * 넣어야 한다 — 판정 방식에서 도출한다. 측정값은 숫자를 적고, 육안은 참·거짓이다.
 */
function dataTypeOf(judgmentMethodCode: string): string {
  return judgmentMethodCode === MEASUREMENT ? 'NUMERIC' : 'BOOLEAN';
}

function required(field: string): ErrorItem {
  return {
    scope: 'field',
    field,
    code: ERROR_CODE.REQUIRED,
    message: '측정값으로 판정하는 항목은 이 칸이 필요합니다.',
  };
}

function view(row: InspectionItemRow): InspectionItemView {
  return {
    equipmentInspectionItemId: Number(row.equipment_inspection_item_id),
    plantId: Number(row.plant_id),
    itemCode: row.inspection_item_code,
    itemName: row.inspection_item_name,
    inspectionTypeCode: row.inspection_type_code,
    judgmentMethodCode: row.judgment_method_code,
    uomId: row.uom_id === null ? null : Number(row.uom_id),
    lowerLimit: row.lower_limit === null ? null : Number(row.lower_limit),
    upperLimit: row.upper_limit === null ? null : Number(row.upper_limit),
    requiredFlag: row.is_required,
    inspectionPoint: row.inspection_point,
    sequenceNo: row.sequence_no,
    isActive: row.is_active,
  };
}
