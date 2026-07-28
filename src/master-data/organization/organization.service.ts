import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { business_unit, legal_entity, plant, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  CreateBusinessUnitDto,
  CreateLegalEntityDto,
  CreatePlantDto,
  UpdateBusinessUnitDto,
  UpdateLegalEntityDto,
  UpdatePlantDto,
} from './organization.dto';

/**
 * 조직 계층 — 법인 → 사업부 / 공장.
 *
 * 창고(mdm.warehouse)가 plant_id·business_unit_id를 NOT NULL로 요구하므로
 * 창고·로케이션의 선행 마스터다.
 */
@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  async createLegalEntity(dto: CreateLegalEntityDto, actor?: bigint): Promise<legal_entity> {
    orConflict(
      await this.prisma.legal_entity.findUnique({
        where: { legal_entity_code: dto.legalEntityCode },
      }),
      `이미 존재하는 법인입니다: ${dto.legalEntityCode}`,
    );

    return this.prisma.legal_entity.create({
      data: {
        legal_entity_code: dto.legalEntityCode,
        legal_entity_name: dto.legalEntityName,
        country_code: dto.countryCode,
        timezone_code: dto.timezoneCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findLegalEntities(query: PageQueryDto): Promise<PageDto<legal_entity>> {
    const where = baseWhere(query, [
      'legal_entity_code',
      'legal_entity_name',
    ]) as Prisma.legal_entityWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.legal_entity.findMany({
        where,
        orderBy: { legal_entity_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.legal_entity.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findLegalEntity(code: string): Promise<legal_entity> {
    return orFail(
      await this.prisma.legal_entity.findUnique({ where: { legal_entity_code: code } }),
      `법인(${code})`,
    );
  }

  async updateLegalEntity(
    code: string,
    dto: UpdateLegalEntityDto,
    actor?: bigint,
  ): Promise<legal_entity> {
    const found = await this.findLegalEntity(code);

    return this.prisma.legal_entity.update({
      where: { legal_entity_id: found.legal_entity_id },
      data: {
        legal_entity_name: dto.legalEntityName,
        country_code: dto.countryCode,
        timezone_code: dto.timezoneCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivateLegalEntity(code: string, actor?: bigint): Promise<void> {
    const found = await this.findLegalEntity(code);

    const [units, plants] = await this.prisma.$transaction([
      this.prisma.business_unit.count({
        where: { legal_entity_id: found.legal_entity_id, is_active: true },
      }),
      this.prisma.plant.count({
        where: { legal_entity_id: found.legal_entity_id, is_active: true },
      }),
    ]);
    if (units + plants > 0) {
      throw new ConflictException(
        `사용중인 하위 조직(사업부 ${units}·공장 ${plants})이 있어 비활성화할 수 없습니다: ${code}`,
      );
    }

    await this.prisma.legal_entity.update({
      where: { legal_entity_id: found.legal_entity_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async createBusinessUnit(dto: CreateBusinessUnitDto, actor?: bigint): Promise<business_unit> {
    const entity = await this.findLegalEntity(dto.legalEntityCode);

    orConflict(
      await this.prisma.business_unit.findUnique({
        where: {
          legal_entity_id_business_unit_code: {
            legal_entity_id: entity.legal_entity_id,
            business_unit_code: dto.businessUnitCode,
          },
        },
      }),
      `이미 존재하는 사업부입니다: ${dto.legalEntityCode}.${dto.businessUnitCode}`,
    );

    return this.prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: dto.businessUnitCode,
        business_unit_name: dto.businessUnitName,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findBusinessUnits(
    legalEntityCode: string,
    query: PageQueryDto,
  ): Promise<PageDto<business_unit>> {
    const entity = await this.findLegalEntity(legalEntityCode);
    const where = baseWhere(query, ['business_unit_code', 'business_unit_name'], {
      legal_entity_id: entity.legal_entity_id,
    }) as Prisma.business_unitWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.business_unit.findMany({
        where,
        orderBy: { business_unit_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.business_unit.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findBusinessUnit(legalEntityCode: string, code: string): Promise<business_unit> {
    const entity = await this.findLegalEntity(legalEntityCode);
    return orFail(
      await this.prisma.business_unit.findUnique({
        where: {
          legal_entity_id_business_unit_code: {
            legal_entity_id: entity.legal_entity_id,
            business_unit_code: code,
          },
        },
      }),
      `사업부(${legalEntityCode}.${code})`,
    );
  }

  async updateBusinessUnit(
    legalEntityCode: string,
    code: string,
    dto: UpdateBusinessUnitDto,
    actor?: bigint,
  ): Promise<business_unit> {
    const found = await this.findBusinessUnit(legalEntityCode, code);

    return this.prisma.business_unit.update({
      where: { business_unit_id: found.business_unit_id },
      data: {
        business_unit_name: dto.businessUnitName,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivateBusinessUnit(
    legalEntityCode: string,
    code: string,
    actor?: bigint,
  ): Promise<void> {
    const found = await this.findBusinessUnit(legalEntityCode, code);

    const warehouses = await this.prisma.warehouse.count({
      where: { business_unit_id: found.business_unit_id, is_active: true },
    });
    if (warehouses > 0) {
      throw new ConflictException(
        `사용중인 창고 ${warehouses}건이 있어 비활성화할 수 없습니다: ${legalEntityCode}.${code}`,
      );
    }

    await this.prisma.business_unit.update({
      where: { business_unit_id: found.business_unit_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async createPlant(dto: CreatePlantDto, actor?: bigint): Promise<plant> {
    const entity = await this.findLegalEntity(dto.legalEntityCode);
    const businessUnitId = await this.resolveBusinessUnitId(dto.legalEntityCode, dto.businessUnitCode);

    orConflict(
      await this.prisma.plant.findUnique({
        where: {
          legal_entity_id_plant_code: {
            legal_entity_id: entity.legal_entity_id,
            plant_code: dto.plantCode,
          },
        },
      }),
      `이미 존재하는 공장입니다: ${dto.legalEntityCode}.${dto.plantCode}`,
    );

    return this.prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: businessUnitId,
        plant_code: dto.plantCode,
        plant_name: dto.plantName,
        timezone_code: dto.timezoneCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findPlants(legalEntityCode: string, query: PageQueryDto): Promise<PageDto<plant>> {
    const entity = await this.findLegalEntity(legalEntityCode);
    const where = baseWhere(query, ['plant_code', 'plant_name'], {
      legal_entity_id: entity.legal_entity_id,
    }) as Prisma.plantWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.plant.findMany({
        where,
        orderBy: { plant_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.plant.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findPlant(legalEntityCode: string, code: string): Promise<plant> {
    const entity = await this.findLegalEntity(legalEntityCode);
    return orFail(
      await this.prisma.plant.findUnique({
        where: {
          legal_entity_id_plant_code: {
            legal_entity_id: entity.legal_entity_id,
            plant_code: code,
          },
        },
      }),
      `공장(${legalEntityCode}.${code})`,
    );
  }

  async updatePlant(
    legalEntityCode: string,
    code: string,
    dto: UpdatePlantDto,
    actor?: bigint,
  ): Promise<plant> {
    const found = await this.findPlant(legalEntityCode, code);
    const businessUnitId =
      dto.businessUnitCode === undefined
        ? undefined
        : await this.resolveBusinessUnitId(legalEntityCode, dto.businessUnitCode);

    return this.prisma.plant.update({
      where: { plant_id: found.plant_id },
      data: {
        business_unit_id: businessUnitId,
        plant_name: dto.plantName,
        timezone_code: dto.timezoneCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivatePlant(legalEntityCode: string, code: string, actor?: bigint): Promise<void> {
    const found = await this.findPlant(legalEntityCode, code);

    const warehouses = await this.prisma.warehouse.count({
      where: { plant_id: found.plant_id, is_active: true },
    });
    if (warehouses > 0) {
      throw new ConflictException(
        `사용중인 창고 ${warehouses}건이 있어 비활성화할 수 없습니다: ${legalEntityCode}.${code}`,
      );
    }

    await this.prisma.plant.update({
      where: { plant_id: found.plant_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /**
   * 공장의 사업부는 선택 항목이다. 지정된 경우 **같은 법인 소속**인지 확인한다 —
   * DDL은 business_unit_id의 법인 일치를 강제하지 않으므로 앱이 막아야 한다.
   */
  private async resolveBusinessUnitId(
    legalEntityCode: string,
    businessUnitCode?: string,
  ): Promise<bigint | null> {
    if (!businessUnitCode) return null;

    const unit = await this.findBusinessUnit(legalEntityCode, businessUnitCode);
    return unit.business_unit_id;
  }

  async resolveForWarehouse(
    legalEntityCode: string,
    plantCode: string,
    businessUnitCode: string,
  ): Promise<{ plantId: bigint; businessUnitId: bigint }> {
    const [plantRow, unit] = await Promise.all([
      this.findPlant(legalEntityCode, plantCode),
      this.findBusinessUnit(legalEntityCode, businessUnitCode),
    ]);

    if (!plantRow.is_active) {
      throw new BadRequestException(`비활성 공장에는 창고를 만들 수 없습니다: ${plantCode}`);
    }
    if (!unit.is_active) {
      throw new BadRequestException(`비활성 사업부는 지정할 수 없습니다: ${businessUnitCode}`);
    }

    return { plantId: plantRow.plant_id, businessUnitId: unit.business_unit_id };
  }
}
