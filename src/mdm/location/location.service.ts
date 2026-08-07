import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toEditability } from '../editability';
import { countReferences } from '../reference-count';
import { LOCATION_REFERENCES } from './location.references';
import { toLocation } from './location.mapper';
import { LocationQueryDto } from './location.query.dto';

type LocationList = {
  items: components['schemas']['Location'][];
  page: components['schemas']['PageMeta'];
};

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 그 분기를 컨트롤러가 한다. */
type LocationDetail = {
  body: components['schemas']['LocationDetailResponse'];
  versionNo: number;
};

@Injectable()
export class LocationService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: LocationQueryDto): Promise<LocationList> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        // 계약에 정렬 기준이 없다. 불안정하면 페이지를 넘길 때 같은 행이 두 번 나오거나
        // 빠지므로 유일키(warehouse_id, location_code)로 못 박는다 — 창고와 같은 판단이다.
        orderBy: [{ warehouse_id: 'asc' }, { location_code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.location.count({ where }),
    ]);

    return {
      items: rows.map(toLocation),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findOne(locationId: bigint): Promise<LocationDetail> {
    const row = await this.prisma.location.findUnique({ where: { location_id: locationId } });
    if (!row) throw new NotFoundException(`로케이션(${locationId})을 찾을 수 없습니다.`);

    const referenceCount = await countReferences(this.prisma, LOCATION_REFERENCES, locationId);

    return {
      body: { location: toLocation(row), editability: toEditability(referenceCount) },
      versionNo: row.version_no,
    };
  }

  private buildWhere(query: LocationQueryDto): Prisma.locationWhereInput {
    const where: Prisma.locationWhereInput = { warehouse_id: BigInt(query.warehouseId) };

    if (!query.includeInactive) where.is_active = true;
    if (query.q) {
      where.OR = [
        { location_code: { contains: query.q, mode: 'insensitive' } },
        { location_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }
}
