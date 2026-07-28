import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, role, role_permission } from '@prisma/client';

import { PageDto } from '../common/dto/page.dto';
import { PageQueryDto } from '../common/dto/page-query.dto';
import { CodeValidatorService } from '../master-data/common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  orConflict,
  orFail,
  updateStamp,
} from '../master-data/common/master-crud';
import { PrismaService } from '../prisma/prisma.service';
import { AddPermissionDto, CreateRoleDto, UpdateRoleDto } from './access.dto';

@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateRoleDto, actor?: bigint): Promise<role> {
    orConflict(
      await this.prisma.role.findUnique({ where: { role_code: dto.roleCode } }),
      `이미 존재하는 역할입니다: ${dto.roleCode}`,
    );

    return this.prisma.role.create({
      data: {
        role_code: dto.roleCode,
        role_name: dto.roleName,
        description: dto.description ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PageQueryDto): Promise<PageDto<role>> {
    const where = baseWhere(query, ['role_code', 'role_name']) as Prisma.roleWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        orderBy: { role_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.role.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(roleCode: string) {
    const found = await this.prisma.role.findUnique({
      where: { role_code: roleCode },
      include: { role_permission: { orderBy: { permission_code: 'asc' } } },
    });
    return orFail(found, `역할(${roleCode})`);
  }

  async update(roleCode: string, dto: UpdateRoleDto, actor?: bigint): Promise<role> {
    const found = await this.getRole(roleCode);

    return this.prisma.role.update({
      where: { role_id: found.role_id },
      data: {
        role_name: dto.roleName,
        description: dto.description,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(roleCode: string, actor?: bigint): Promise<void> {
    const found = await this.getRole(roleCode);

    const assigned = await this.prisma.user_role.count({ where: { role_id: found.role_id } });
    if (assigned > 0) {
      throw new ConflictException(
        `사용자 ${assigned}명에게 부여돼 있어 비활성화할 수 없습니다: ${roleCode}`,
      );
    }

    await this.prisma.role.update({
      where: { role_id: found.role_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async addPermission(
    roleCode: string,
    dto: AddPermissionDto,
    actor?: bigint,
  ): Promise<role_permission> {
    const found = await this.getRole(roleCode);
    await this.codes.assertValid('PERMISSION', dto.permissionCode);

    orConflict(
      await this.prisma.role_permission.findUnique({
        where: {
          role_id_permission_code: {
            role_id: found.role_id,
            permission_code: dto.permissionCode,
          },
        },
      }),
      `이미 부여된 권한입니다: ${roleCode}.${dto.permissionCode}`,
    );

    return this.prisma.role_permission.create({
      data: {
        role_id: found.role_id,
        permission_code: dto.permissionCode,
        created_by: actor,
      },
    });
  }

  async findPermissions(roleCode: string): Promise<role_permission[]> {
    const found = await this.getRole(roleCode);
    return this.prisma.role_permission.findMany({
      where: { role_id: found.role_id },
      orderBy: { permission_code: 'asc' },
    });
  }

  /** 단순 매핑이라 비활성 플래그가 없다. */
  async removePermission(roleCode: string, permissionCode: string): Promise<void> {
    const found = await this.getRole(roleCode);
    const row = orFail(
      await this.prisma.role_permission.findUnique({
        where: {
          role_id_permission_code: { role_id: found.role_id, permission_code: permissionCode },
        },
      }),
      `권한(${roleCode}.${permissionCode})`,
    );

    await this.prisma.role_permission.delete({
      where: { role_permission_id: row.role_permission_id },
    });
  }

  async getRole(roleCode: string): Promise<role> {
    return orFail(
      await this.prisma.role.findUnique({ where: { role_code: roleCode } }),
      `역할(${roleCode})`,
    );
  }
}
