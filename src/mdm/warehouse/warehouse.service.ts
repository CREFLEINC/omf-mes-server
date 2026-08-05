import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toEditability } from './warehouse.editability';
import { toWarehouse } from './warehouse.mapper';
import { WarehouseQueryDto } from './warehouse.query.dto';
import { countWarehouseReferences } from './warehouse.references';

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
  constructor(private readonly prisma: PrismaService) {}

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
