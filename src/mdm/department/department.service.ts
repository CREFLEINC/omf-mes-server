import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toEditability } from '../editability';
import { countReferences } from '../reference-count';
import { toDepartment } from './department.mapper';
import { DepartmentQueryDto } from './department.query.dto';
import { DEPARTMENT_REFERENCES } from './department.references';

type DepartmentList = {
  items: components['schemas']['Department'][];
  page: components['schemas']['PageMeta'];
};

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 분기는 컨트롤러가 한다. */
type DepartmentDetail = {
  body: components['schemas']['DepartmentDetailResponse'];
  versionNo: number;
};

@Injectable()
export class DepartmentService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: DepartmentQueryDto): Promise<DepartmentList> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.department.findMany({
        where,
        // 계약에 정렬이 없다. department_code 가 전역 유일키라 페이지가 흔들리지 않는다 —
        // 창고·로케이션이 (부모, 코드) 두 칸을 쓴 것과 달리 한 칸으로 충분하다.
        orderBy: { department_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.department.count({ where }),
    ]);

    return {
      items: rows.map(toDepartment),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findOne(departmentId: bigint): Promise<DepartmentDetail> {
    const row = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
    });
    if (!row) throw new NotFoundException(`부서(${departmentId})를 찾을 수 없습니다.`);

    const referenceCount = await countReferences(
      this.prisma,
      DEPARTMENT_REFERENCES,
      departmentId,
    );

    return {
      body: { department: toDepartment(row), editability: toEditability(referenceCount) },
      versionNo: row.version_no,
    };
  }

  private buildWhere(query: DepartmentQueryDto): Prisma.departmentWhereInput {
    const where: Prisma.departmentWhereInput = {};

    if (!query.includeInactive) where.is_active = true;
    if (query.businessUnitId) where.business_unit_id = BigInt(query.businessUnitId);
    if (query.q) {
      where.OR = [
        { department_code: { contains: query.q, mode: 'insensitive' } },
        { department_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    return where;
  }
}
