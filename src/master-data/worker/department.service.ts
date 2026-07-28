import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { department, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { CreateDepartmentDto, UpdateDepartmentDto } from './worker.dto';

@Injectable()
export class DepartmentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDepartmentDto, actor?: bigint): Promise<department> {
    orConflict(
      await this.prisma.department.findUnique({
        where: { department_code: dto.departmentCode },
      }),
      `이미 존재하는 부서입니다: ${dto.departmentCode}`,
    );

    const parentId = await this.resolveParent(dto.parentDepartmentCode);
    const businessUnitId = await this.resolveBusinessUnit(dto.businessUnitCode);

    return this.prisma.department.create({
      data: {
        department_code: dto.departmentCode,
        department_name: dto.departmentName,
        parent_department_id: parentId,
        business_unit_id: businessUnitId,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PageQueryDto): Promise<PageDto<department>> {
    const where = baseWhere(query, [
      'department_code',
      'department_name',
    ]) as Prisma.departmentWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.department.findMany({
        where,
        orderBy: { department_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.department.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(departmentCode: string): Promise<department> {
    return this.getDepartment(departmentCode);
  }

  async update(
    departmentCode: string,
    dto: UpdateDepartmentDto,
    actor?: bigint,
  ): Promise<department> {
    const found = await this.getDepartment(departmentCode);

    const parentId =
      dto.parentDepartmentCode === undefined
        ? found.parent_department_id
        : await this.resolveParent(dto.parentDepartmentCode, found.department_id);
    const businessUnitId =
      dto.businessUnitCode === undefined
        ? undefined
        : await this.resolveBusinessUnit(dto.businessUnitCode);

    return this.prisma.department.update({
      where: { department_id: found.department_id },
      data: {
        department_name: dto.departmentName,
        parent_department_id: parentId,
        business_unit_id: businessUnitId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(departmentCode: string, actor?: bigint): Promise<void> {
    const found = await this.getDepartment(departmentCode);

    const [children, workers] = await this.prisma.$transaction([
      this.prisma.department.count({
        where: { parent_department_id: found.department_id, is_active: true },
      }),
      this.prisma.worker.count({
        where: { department_id: found.department_id, is_active: true },
      }),
    ]);
    if (children + workers > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${departmentCode} (하위 부서 ${children}·작업자 ${workers})`,
      );
    }

    await this.prisma.department.update({
      where: { department_id: found.department_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async resolveId(departmentCode?: string): Promise<bigint | null> {
    if (!departmentCode) return null;
    return (await this.getDepartment(departmentCode)).department_id;
  }

  private async getDepartment(departmentCode: string): Promise<department> {
    return orFail(
      await this.prisma.department.findUnique({ where: { department_code: departmentCode } }),
      `부서(${departmentCode})`,
    );
  }

  private async resolveBusinessUnit(businessUnitCode?: string): Promise<bigint | null> {
    if (!businessUnitCode) return null;

    const rows = await this.prisma.business_unit.findMany({
      where: { business_unit_code: businessUnitCode },
      take: 2,
    });
    if (rows.length === 0) orFail(null, `사업부(${businessUnitCode})`);
    if (rows.length > 1) {
      throw new ConflictException(
        `사업부코드 ${businessUnitCode}가 여러 법인에 존재합니다. 법인을 함께 지정해야 합니다.`,
      );
    }
    return rows[0].business_unit_id;
  }

  /** DDL은 자기참조만 막는다 — 자손을 가리키는 순환은 앱이 막는다. */
  private async resolveParent(parentCode?: string, selfId?: bigint): Promise<bigint | null> {
    if (!parentCode) return null;

    const parent = orFail(
      await this.prisma.department.findUnique({ where: { department_code: parentCode } }),
      `상위 부서(${parentCode})`,
    );

    if (selfId !== undefined) {
      if (parent.department_id === selfId) {
        throw new BadRequestException('자기 자신을 상위 부서로 지정할 수 없습니다.');
      }
      let cursor: bigint | null = parent.parent_department_id;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (cursor === selfId) {
          throw new BadRequestException('상위 부서 지정이 순환을 만듭니다.');
        }
        if (seen.has(cursor.toString())) break;
        seen.add(cursor.toString());
        const next: { parent_department_id: bigint | null } | null =
          await this.prisma.department.findUnique({
            where: { department_id: cursor },
            select: { parent_department_id: true },
          });
        cursor = next?.parent_department_id ?? null;
      }
    }

    return parent.department_id;
  }
}
