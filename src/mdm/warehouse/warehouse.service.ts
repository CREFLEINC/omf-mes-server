import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { ContractBadRequest } from '../../common/errors/contract-error';
import { CreateWarehouseDto } from './warehouse.create.dto';
import { toEditability } from './warehouse.editability';
import { toWarehouse } from './warehouse.mapper';
import { WarehouseQueryDto } from './warehouse.query.dto';
import { countWarehouseReferences } from './warehouse.references';
import { WarehouseValidator } from './warehouse.validator';

type WarehouseList = {
  items: components['schemas']['Warehouse'][];
  page: components['schemas']['PageMeta'];
};

/**
 * 상세 조회 결과. `versionNo` 는 본문이 아니라 ETag 헤더로 나간다 — 공유계약 A-4 가
 * 본문 노출을 금지하고 B-1 이 낙관적 잠금 토큰으로 요구한다. 그 분기를 컨트롤러가 한다.
 */
type WarehouseDetail = {
  body: components['schemas']['WarehouseDetailResponse'];
  versionNo: number;
};

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: WarehouseValidator,
  ) {}

  async create(
    dto: CreateWarehouseDto,
    actorId: bigint,
  ): Promise<components['schemas']['Warehouse']> {
    const errors = await this.validator.validateCreate(dto);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    const row = await this.prisma.warehouse.create({
      data: {
        plant_id: BigInt(dto.plantId),
        business_unit_id: BigInt(dto.businessUnitId),
        warehouse_code: dto.warehouseCode,
        warehouse_name: dto.warehouseName,
        warehouse_type_code: dto.warehouseTypeCode,
        management_level_code: dto.managementLevelCode,
        is_external: dto.isExternal,
        // 외부창고가 아니면 거래처를 지운다 — 화면이 체크를 껐는데 값이 남아 오면
        // ck_external_warehouse_partner 는 통과하지만 데이터가 앞뒤가 안 맞는다.
        partner_id: dto.isExternal && dto.partnerId ? BigInt(dto.partnerId) : null,
        // is_active 는 받지 않는다 — 신규는 항상 사용 중이다(계약 WarehouseCreate).
        created_by: actorId,
        updated_by: actorId,
      },
    });

    return toWarehouse(row);
  }

  async findAll(query: WarehouseQueryDto): Promise<WarehouseList> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        // 계약에 정렬 기준이 없다. 불안정하면 페이지를 넘길 때 같은 행이 두 번 나오거나
        // 빠지므로 유일키(plant_id, warehouse_code)로 못 박는다.
        orderBy: [{ plant_id: 'asc' }, { warehouse_code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    return {
      items: rows.map(toWarehouse),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findOne(warehouseId: bigint): Promise<WarehouseDetail> {
    const row = await this.prisma.warehouse.findUnique({ where: { warehouse_id: warehouseId } });
    if (!row) throw new NotFoundException(`창고(${warehouseId})를 찾을 수 없습니다.`);

    const referenceCount = await countWarehouseReferences(this.prisma, warehouseId);

    return {
      body: { warehouse: toWarehouse(row), editability: toEditability(referenceCount) },
      versionNo: row.version_no,
    };
  }

  private buildWhere(query: WarehouseQueryDto): Prisma.warehouseWhereInput {
    const where: Prisma.warehouseWhereInput = {};

    if (!query.includeInactive) where.is_active = true;
    if (query.warehouseTypeCode) where.warehouse_type_code = query.warehouseTypeCode;
    if (query.q) {
      where.OR = [
        { warehouse_code: { contains: query.q, mode: 'insensitive' } },
        { warehouse_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }
}
