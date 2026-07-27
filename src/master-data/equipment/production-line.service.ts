import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, production_line } from '@prisma/client';

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
import {
  CreateProductionLineDto,
  ProductionLineQueryDto,
  UpdateProductionLineDto,
} from './equipment.dto';

/**
 * 생산라인·작업구역 — mdm.production_line.
 * `line_type_code = LINE | WORK_AREA` (DDL 주석 명시). 작업구역은 라인 하위에 계층 구성한다.
 */
@Injectable()
export class ProductionLineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateProductionLineDto, actor?: bigint): Promise<production_line> {
    const plant = await this.org.findPlant(dto.legalEntityCode, dto.plantCode);
    await this.codes.assertValid('LINE_TYPE', dto.lineTypeCode);
    const parentId = await this.resolveParent(plant.plant_id, dto.parentLineCode);

    orConflict(
      await this.prisma.production_line.findUnique({
        where: { plant_id_line_code: { plant_id: plant.plant_id, line_code: dto.lineCode } },
      }),
      `이미 존재하는 생산라인입니다: ${dto.plantCode}.${dto.lineCode}`,
    );

    return this.prisma.production_line.create({
      data: {
        plant_id: plant.plant_id,
        parent_line_id: parentId,
        line_code: dto.lineCode,
        line_name: dto.lineName,
        line_type_code: dto.lineTypeCode ?? 'LINE',
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: ProductionLineQueryDto): Promise<PageDto<production_line>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };
    if (query.lineTypeCode) extra.line_type_code = query.lineTypeCode;

    const where = baseWhere(query, [
      'line_code',
      'line_name',
    ], extra) as Prisma.production_lineWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.production_line.findMany({
        where,
        orderBy: { line_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.production_line.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(lineCode: string): Promise<production_line> {
    return this.getLine(lineCode);
  }

  async update(
    lineCode: string,
    dto: UpdateProductionLineDto,
    actor?: bigint,
  ): Promise<production_line> {
    const found = await this.getLine(lineCode);
    await this.codes.assertValid('LINE_TYPE', dto.lineTypeCode);

    const parentId =
      dto.parentLineCode === undefined
        ? found.parent_line_id
        : await this.resolveParent(found.plant_id, dto.parentLineCode, found.production_line_id);

    return this.prisma.production_line.update({
      where: { production_line_id: found.production_line_id },
      data: {
        parent_line_id: parentId,
        line_name: dto.lineName,
        line_type_code: dto.lineTypeCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(lineCode: string, actor?: bigint): Promise<void> {
    const found = await this.getLine(lineCode);

    const [children, equipments] = await this.prisma.$transaction([
      this.prisma.production_line.count({
        where: { parent_line_id: found.production_line_id, is_active: true },
      }),
      this.prisma.equipment.count({
        where: { production_line_id: found.production_line_id, is_active: true },
      }),
    ]);
    if (children + equipments > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${lineCode} (하위 라인 ${children}·설비 ${equipments})`,
      );
    }

    await this.prisma.production_line.update({
      where: { production_line_id: found.production_line_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /** 설비 등록에서 쓰는 조회 — 같은 공장 소속인지 확인한다. */
  async resolveForPlant(plantId: bigint, lineCode?: string): Promise<bigint | null> {
    if (!lineCode) return null;

    const line = orFail(
      await this.prisma.production_line.findUnique({
        where: { plant_id_line_code: { plant_id: plantId, line_code: lineCode } },
      }),
      `생산라인(${lineCode})`,
    );
    return line.production_line_id;
  }

  private async getLine(lineCode: string): Promise<production_line> {
    const rows = await this.prisma.production_line.findMany({
      where: { line_code: lineCode },
      take: 2,
    });
    return exactlyOne(rows, '생산라인', lineCode);
  }

  /** 상위 라인은 같은 공장이어야 하고, 자기 자신이나 자손을 가리킬 수 없다(DDL은 자기참조만 막는다). */
  private async resolveParent(
    plantId: bigint,
    parentCode?: string,
    selfId?: bigint,
  ): Promise<bigint | null> {
    if (!parentCode) return null;

    const parent = orFail(
      await this.prisma.production_line.findUnique({
        where: { plant_id_line_code: { plant_id: plantId, line_code: parentCode } },
      }),
      `상위 생산라인(${parentCode})`,
    );

    if (selfId !== undefined) {
      if (parent.production_line_id === selfId) {
        throw new BadRequestException('자기 자신을 상위 라인으로 지정할 수 없습니다.');
      }
      let cursor: bigint | null = parent.parent_line_id;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (cursor === selfId) {
          throw new BadRequestException('상위 라인 지정이 순환을 만듭니다.');
        }
        if (seen.has(cursor.toString())) break;
        seen.add(cursor.toString());
        const next: { parent_line_id: bigint | null } | null =
          await this.prisma.production_line.findUnique({
            where: { production_line_id: cursor },
            select: { parent_line_id: true },
          });
        cursor = next?.parent_line_id ?? null;
      }
    }

    return parent.production_line_id;
  }
}
