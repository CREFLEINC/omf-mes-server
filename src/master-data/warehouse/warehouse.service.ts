import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { location, Prisma, warehouse } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import {
  CreateLocationDto,
  CreateWarehouseDto,
  UpdateLocationDto,
  UpdateWarehouseDto,
} from './warehouse.dto';

/** 창고·로케이션 마스터 — mdm.warehouse / mdm.location */
@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly codes: CodeValidatorService,
  ) {}

  // ── 창고 ──────────────────────────────────────────────────────────────

  async create(dto: CreateWarehouseDto, actor?: bigint): Promise<warehouse> {
    const { plantId, businessUnitId } = await this.org.resolveForWarehouse(
      dto.legalEntityCode,
      dto.plantCode,
      dto.businessUnitCode,
    );
    await this.codes.assertAllValid([
      ['WAREHOUSE_TYPE', dto.warehouseTypeCode],
      ['MANAGEMENT_LEVEL', dto.managementLevelCode],
    ]);
    const partnerId = await this.resolvePartner(dto.isExternal ?? false, dto.partnerCode);

    orConflict(
      await this.prisma.warehouse.findUnique({
        where: {
          plant_id_warehouse_code: { plant_id: plantId, warehouse_code: dto.warehouseCode },
        },
      }),
      `이미 존재하는 창고입니다: ${dto.plantCode}.${dto.warehouseCode}`,
    );

    return this.prisma.warehouse.create({
      data: {
        plant_id: plantId,
        business_unit_id: businessUnitId,
        warehouse_code: dto.warehouseCode,
        warehouse_name: dto.warehouseName,
        warehouse_type_code: dto.warehouseTypeCode,
        management_level_code: dto.managementLevelCode,
        is_external: dto.isExternal ?? false,
        partner_id: partnerId,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PageQueryDto, plantCode?: string): Promise<PageDto<warehouse>> {
    const extra = plantCode ? { plant: { plant_code: plantCode } } : {};
    const where = baseWhere(query, [
      'warehouse_code',
      'warehouse_name',
    ], extra) as Prisma.warehouseWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        orderBy: { warehouse_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.warehouse.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(warehouseCode: string): Promise<warehouse> {
    return this.getWarehouse(warehouseCode);
  }

  async update(
    warehouseCode: string,
    dto: UpdateWarehouseDto,
    actor?: bigint,
  ): Promise<warehouse> {
    const found = await this.getWarehouse(warehouseCode);
    await this.codes.assertAllValid([
      ['WAREHOUSE_TYPE', dto.warehouseTypeCode],
      ['MANAGEMENT_LEVEL', dto.managementLevelCode],
    ]);

    // 외부창고 여부는 거래처와 짝이다 — 저장될 최종 상태로 검사한다(DDL ck_external_warehouse_partner).
    const isExternal = dto.isExternal ?? found.is_external;
    const partnerId =
      dto.partnerCode === undefined && dto.isExternal === undefined
        ? found.partner_id
        : await this.resolvePartner(isExternal, dto.partnerCode, found.partner_id);

    return this.prisma.warehouse.update({
      where: { warehouse_id: found.warehouse_id },
      data: {
        warehouse_name: dto.warehouseName,
        warehouse_type_code: dto.warehouseTypeCode,
        management_level_code: dto.managementLevelCode,
        is_external: dto.isExternal,
        partner_id: partnerId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(warehouseCode: string, actor?: bigint): Promise<void> {
    const found = await this.getWarehouse(warehouseCode);

    const locations = await this.prisma.location.count({
      where: { warehouse_id: found.warehouse_id, is_active: true },
    });
    if (locations > 0) {
      throw new ConflictException(
        `사용중인 로케이션 ${locations}건이 있어 비활성화할 수 없습니다: ${warehouseCode}`,
      );
    }

    await this.prisma.warehouse.update({
      where: { warehouse_id: found.warehouse_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  // ── 로케이션 ──────────────────────────────────────────────────────────

  async createLocation(
    warehouseCode: string,
    dto: CreateLocationDto,
    actor?: bigint,
  ): Promise<location> {
    const wh = await this.getWarehouse(warehouseCode);
    await this.codes.assertAllValid([
      ['LOCATION_TYPE', dto.locationTypeCode],
      ['QUALITY_ZONE', dto.qualityZoneCode],
      ['STORAGE_CONDITION', dto.storageConditionCode],
    ]);
    const capacityUomId = await this.resolveCapacity(dto.capacityQty, dto.capacityUomCode);
    const parentId = await this.resolveParent(wh.warehouse_id, dto.parentLocationCode);

    orConflict(
      await this.prisma.location.findUnique({
        where: {
          warehouse_id_location_code: {
            warehouse_id: wh.warehouse_id,
            location_code: dto.locationCode,
          },
        },
      }),
      `이미 존재하는 로케이션입니다: ${warehouseCode}.${dto.locationCode}`,
    );

    return this.prisma.location.create({
      data: {
        warehouse_id: wh.warehouse_id,
        parent_location_id: parentId,
        location_code: dto.locationCode,
        location_name: dto.locationName,
        location_type_code: dto.locationTypeCode,
        quality_zone_code: dto.qualityZoneCode ?? null,
        storage_condition_code: dto.storageConditionCode ?? null,
        allow_mixed_item: dto.allowMixedItem ?? true,
        allow_mixed_lot: dto.allowMixedLot ?? true,
        capacity_qty: dto.capacityQty ?? null,
        capacity_uom_id: capacityUomId,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findLocations(warehouseCode: string, query: PageQueryDto): Promise<PageDto<location>> {
    const wh = await this.getWarehouse(warehouseCode);
    const where = baseWhere(query, ['location_code', 'location_name'], {
      warehouse_id: wh.warehouse_id,
    }) as Prisma.locationWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        orderBy: { location_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.location.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findLocation(warehouseCode: string, locationCode: string): Promise<location> {
    const wh = await this.getWarehouse(warehouseCode);
    return orFail(
      await this.prisma.location.findUnique({
        where: {
          warehouse_id_location_code: {
            warehouse_id: wh.warehouse_id,
            location_code: locationCode,
          },
        },
      }),
      `로케이션(${warehouseCode}.${locationCode})`,
    );
  }

  async updateLocation(
    warehouseCode: string,
    locationCode: string,
    dto: UpdateLocationDto,
    actor?: bigint,
  ): Promise<location> {
    const found = await this.findLocation(warehouseCode, locationCode);
    await this.codes.assertAllValid([
      ['LOCATION_TYPE', dto.locationTypeCode],
      ['QUALITY_ZONE', dto.qualityZoneCode],
      ['STORAGE_CONDITION', dto.storageConditionCode],
    ]);

    // 수용량·단위는 둘 다 있거나 둘 다 없어야 한다 — 저장될 최종 상태로 검사한다.
    const finalQty = dto.capacityQty ?? (found.capacity_qty ? Number(found.capacity_qty) : undefined);
    const capacityUomId =
      dto.capacityQty === undefined && dto.capacityUomCode === undefined
        ? found.capacity_uom_id
        : await this.resolveCapacity(finalQty, dto.capacityUomCode, found.capacity_uom_id);

    const parentId =
      dto.parentLocationCode === undefined
        ? found.parent_location_id
        : await this.resolveParent(found.warehouse_id, dto.parentLocationCode, found.location_id);

    return this.prisma.location.update({
      where: { location_id: found.location_id },
      data: {
        parent_location_id: parentId,
        location_name: dto.locationName,
        location_type_code: dto.locationTypeCode,
        quality_zone_code: dto.qualityZoneCode,
        storage_condition_code: dto.storageConditionCode,
        allow_mixed_item: dto.allowMixedItem,
        allow_mixed_lot: dto.allowMixedLot,
        capacity_qty: dto.capacityQty,
        capacity_uom_id: capacityUomId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivateLocation(
    warehouseCode: string,
    locationCode: string,
    actor?: bigint,
  ): Promise<void> {
    const found = await this.findLocation(warehouseCode, locationCode);

    const children = await this.prisma.location.count({
      where: { parent_location_id: found.location_id, is_active: true },
    });
    if (children > 0) {
      throw new ConflictException(
        `사용중인 하위 로케이션 ${children}건이 있어 비활성화할 수 없습니다: ${locationCode}`,
      );
    }

    await this.prisma.location.update({
      where: { location_id: found.location_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  /**
   * 창고코드는 (plant_id, warehouse_code)로만 유니크하다 — 전역 유니크가 아니다.
   * 공장이 여럿이면 같은 창고코드가 중복될 수 있어, 그 경우 명시적으로 거부한다.
   */
  private async getWarehouse(warehouseCode: string): Promise<warehouse> {
    const rows = await this.prisma.warehouse.findMany({
      where: { warehouse_code: warehouseCode },
      take: 2,
    });
    if (rows.length === 0) {
      throw new NotFoundException(`창고(${warehouseCode})을(를) 찾을 수 없습니다.`);
    }
    if (rows.length > 1) {
      throw new ConflictException(
        `창고코드 ${warehouseCode}가 여러 공장에 존재합니다. 공장을 함께 지정해 조회하십시오.`,
      );
    }
    return rows[0];
  }

  /** DDL ck_external_warehouse_partner — 외부창고면 거래처가 필수. */
  private async resolvePartner(
    isExternal: boolean,
    partnerCode?: string,
    fallback?: bigint | null,
  ): Promise<bigint | null> {
    if (!partnerCode) {
      if (isExternal && !fallback) {
        throw new BadRequestException('외부창고는 거래처(partnerCode)가 필요합니다.');
      }
      return isExternal ? (fallback ?? null) : null;
    }

    const partner = orFail(
      await this.prisma.partner.findUnique({ where: { partner_code: partnerCode } }),
      `거래처(${partnerCode})`,
    );
    return partner.partner_id;
  }

  /** DDL ck_location_capacity — 수용량과 단위는 둘 다 있거나 둘 다 없어야 한다. */
  private async resolveCapacity(
    capacityQty?: number,
    capacityUomCode?: string,
    fallback?: bigint | null,
  ): Promise<bigint | null> {
    const uomId = capacityUomCode
      ? orFail(
          await this.prisma.uom.findUnique({ where: { uom_code: capacityUomCode } }),
          `단위(${capacityUomCode})`,
        ).uom_id
      : (fallback ?? null);

    const hasQty = capacityQty !== undefined && capacityQty !== null;
    if (hasQty !== (uomId !== null)) {
      throw new BadRequestException('수용량(capacityQty)과 단위(capacityUomCode)는 함께 지정해야 합니다.');
    }
    return uomId;
  }

  /** 상위 로케이션은 같은 창고 안이어야 하고, 자기 자신이나 자손을 가리킬 수 없다. */
  private async resolveParent(
    warehouseId: bigint,
    parentCode?: string,
    selfId?: bigint,
  ): Promise<bigint | null> {
    if (!parentCode) return null;

    const parent = orFail(
      await this.prisma.location.findUnique({
        where: {
          warehouse_id_location_code: { warehouse_id: warehouseId, location_code: parentCode },
        },
      }),
      `상위 로케이션(${parentCode})`,
    );

    if (selfId !== undefined) {
      if (parent.location_id === selfId) {
        throw new BadRequestException('자기 자신을 상위 로케이션으로 지정할 수 없습니다.');
      }
      // 자손을 상위로 지정하면 순환이 된다. DDL에 순환 방지 제약이 없어 앱이 막는다.
      let cursor: bigint | null = parent.parent_location_id;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (cursor === selfId) {
          throw new BadRequestException('상위 로케이션 지정이 순환을 만듭니다.');
        }
        if (seen.has(cursor.toString())) break;
        seen.add(cursor.toString());
        const next: { parent_location_id: bigint | null } | null =
          await this.prisma.location.findUnique({
            where: { location_id: cursor },
            select: { parent_location_id: true },
          });
        cursor = next?.parent_location_id ?? null;
      }
    }

    return parent.location_id;
  }
}
