import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { equipment, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  orFail,
  updateStamp,
} from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import { CreateEquipmentDto, EquipmentQueryDto, UpdateEquipmentDto } from './equipment.dto';
import { ProductionLineService } from './production-line.service';

@Injectable()
export class EquipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly lines: ProductionLineService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateEquipmentDto, actor?: bigint): Promise<equipment> {
    const plant = await this.org.findPlant(dto.legalEntityCode, dto.plantCode);
    await this.codes.assertAllValid([
      ['EQUIPMENT_TYPE', dto.equipmentTypeCode],
      ['EQUIPMENT_STATUS', dto.statusCode],
    ]);
    this.assertCalibrationDueAfterLast(dto.lastCalibrationDate, dto.calibrationDueDate);

    const [processId, lineId] = await Promise.all([
      this.resolveProcess(dto.processCode),
      this.lines.resolveForPlant(plant.plant_id, dto.productionLineCode),
    ]);

    orConflict(
      await this.prisma.equipment.findUnique({
        where: {
          plant_id_equipment_code: {
            plant_id: plant.plant_id,
            equipment_code: dto.equipmentCode,
          },
        },
      }),
      `이미 존재하는 설비입니다: ${dto.plantCode}.${dto.equipmentCode}`,
    );

    return this.prisma.equipment.create({
      data: {
        plant_id: plant.plant_id,
        equipment_code: dto.equipmentCode,
        equipment_name: dto.equipmentName,
        equipment_type_code: dto.equipmentTypeCode,
        status_code: dto.statusCode,
        process_id: processId,
        production_line_id: lineId,
        calibration_required: dto.calibrationRequired ?? false,
        last_calibration_date: dto.lastCalibrationDate ?? null,
        calibration_due_date: dto.calibrationDueDate ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: EquipmentQueryDto): Promise<PageDto<equipment>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };
    if (query.equipmentTypeCode) extra.equipment_type_code = query.equipmentTypeCode;
    if (query.statusCode) extra.status_code = query.statusCode;
    if (query.calibrationDueBefore) {
      // 교정 만료 임박·경과 조회. 교정 대상이 아닌 설비는 대상에서 뺀다.
      extra.calibration_required = true;
      extra.calibration_due_date = { lte: query.calibrationDueBefore };
    }

    const where = baseWhere(query, [
      'equipment_code',
      'equipment_name',
    ], extra) as Prisma.equipmentWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.equipment.findMany({
        where,
        orderBy: { equipment_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.equipment.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(equipmentCode: string) {
    const found = await this.getEquipment(equipmentCode);
    return this.prisma.equipment.findUnique({
      where: { equipment_id: found.equipment_id },
      include: { process: true, production_line: true },
    });
  }

  async update(
    equipmentCode: string,
    dto: UpdateEquipmentDto,
    actor?: bigint,
  ): Promise<equipment> {
    const found = await this.getEquipment(equipmentCode);
    await this.codes.assertAllValid([
      ['EQUIPMENT_TYPE', dto.equipmentTypeCode],
      ['EQUIPMENT_STATUS', dto.statusCode],
    ]);

    this.assertCalibrationDueAfterLast(
      dto.lastCalibrationDate ?? found.last_calibration_date ?? undefined,
      dto.calibrationDueDate ?? found.calibration_due_date ?? undefined,
    );

    const processId =
      dto.processCode === undefined ? undefined : await this.resolveProcess(dto.processCode);
    const lineId =
      dto.productionLineCode === undefined
        ? undefined
        : await this.lines.resolveForPlant(found.plant_id, dto.productionLineCode);

    return this.prisma.equipment.update({
      where: { equipment_id: found.equipment_id },
      data: {
        equipment_name: dto.equipmentName,
        equipment_type_code: dto.equipmentTypeCode,
        status_code: dto.statusCode,
        process_id: processId,
        production_line_id: lineId,
        calibration_required: dto.calibrationRequired,
        last_calibration_date: dto.lastCalibrationDate,
        calibration_due_date: dto.calibrationDueDate,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 비활성화.
   *
   * 설비는 작업지시 자원배정·작업세션·검사 등 트랜잭션에서도 참조되지만, 해당 모듈이
   * 아직 없어 미검사다. 지금은 마스터 참조(검사기준의 기본 검사장비)만 본다.
   */
  async deactivate(equipmentCode: string, actor?: bigint): Promise<void> {
    const found = await this.getEquipment(equipmentCode);

    const inspectionDefaults = await this.prisma.inspection_item_spec.count({
      where: { default_inspection_equipment_id: found.equipment_id },
    });
    if (inspectionDefaults > 0) {
      throw new ConflictException(
        `검사항목 기준 ${inspectionDefaults}건이 기본 검사장비로 참조 중이라 비활성화할 수 없습니다: ${equipmentCode}`,
      );
    }

    await this.prisma.equipment.update({
      where: { equipment_id: found.equipment_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /** DDL에 제약이 없어 앱에서만 막는다. */
  private assertCalibrationDueAfterLast(last?: Date | null, due?: Date | null): void {
    if (last && due && due < last) {
      throw new BadRequestException('교정 만료일은 최종 교정일보다 빠를 수 없습니다.');
    }
  }

  private async resolveProcess(processCode?: string): Promise<bigint | null> {
    if (!processCode) return null;

    const found = orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
    return found.process_id;
  }

  private async getEquipment(equipmentCode: string): Promise<equipment> {
    const rows = await this.prisma.equipment.findMany({
      where: { equipment_code: equipmentCode },
      take: 2,
    });
    return exactlyOne(rows, '설비', equipmentCode);
  }
}
