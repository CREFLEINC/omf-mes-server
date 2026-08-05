import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toWarehouse } from './warehouse.mapper';
import { WarehouseQueryDto } from './warehouse.query.dto';

type WarehouseList = {
  items: components['schemas']['Warehouse'][];
  page: components['schemas']['PageMeta'];
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
