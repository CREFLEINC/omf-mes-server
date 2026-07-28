import { BadRequestException, Injectable } from '@nestjs/common';
import { app_user, Prisma, user_data_scope, user_role } from '@prisma/client';

import { PageDto } from '../common/dto/page.dto';
import { CodeValidatorService } from '../master-data/common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  orConflict,
  orFail,
  updateStamp,
} from '../master-data/common/master-crud';
import { DepartmentService } from '../master-data/worker/department.service';
import { OrganizationService } from '../master-data/organization/organization.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddDataScopeDto,
  AssignRoleDto,
  CreateUserDto,
  UpdateUserDto,
  UserQueryDto,
} from './access.dto';
import { RoleService } from './role.service';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RoleService,
    private readonly departments: DepartmentService,
    private readonly org: OrganizationService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateUserDto, actor?: bigint): Promise<app_user> {
    await this.codes.assertValid('USER_STATUS', dto.statusCode);

    orConflict(
      await this.prisma.app_user.findUnique({ where: { login_id: dto.loginId } }),
      `이미 존재하는 로그인 ID입니다: ${dto.loginId}`,
    );

    const departmentId = await this.departments.resolveId(dto.departmentCode);

    return this.prisma.app_user.create({
      data: {
        login_id: dto.loginId,
        user_name: dto.userName,
        email: dto.email ?? null,
        department_id: departmentId,
        status_code: dto.statusCode ?? 'ACTIVE',
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: UserQueryDto): Promise<PageDto<app_user>> {
    const extra: Record<string, unknown> = {};
    if (query.statusCode) extra.status_code = query.statusCode;
    if (query.roleCode) {
      extra.user_role = { some: { role: { role_code: query.roleCode } } };
    }

    const where = baseWhere(query, ['login_id', 'user_name', 'email'], extra) as Prisma.app_userWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.app_user.findMany({
        where,
        orderBy: { login_id: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.app_user.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(loginId: string) {
    const found = await this.prisma.app_user.findUnique({
      where: { login_id: loginId },
      include: {
        department: true,
        user_role: { include: { role: true } },
        user_data_scope: true,
      },
    });
    return orFail(found, `사용자(${loginId})`);
  }

  async update(loginId: string, dto: UpdateUserDto, actor?: bigint): Promise<app_user> {
    const found = await this.getUser(loginId);
    await this.codes.assertValid('USER_STATUS', dto.statusCode);

    const departmentId =
      dto.departmentCode === undefined
        ? undefined
        : await this.departments.resolveId(dto.departmentCode);

    return this.prisma.app_user.update({
      where: { app_user_id: found.app_user_id },
      data: {
        user_name: dto.userName,
        email: dto.email,
        department_id: departmentId,
        status_code: dto.statusCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /** 역할·접근범위는 지우지 않는다 — 재활성화 시 그대로 살아나야 한다. */
  async deactivate(loginId: string, actor?: bigint): Promise<void> {
    const found = await this.getUser(loginId);

    await this.prisma.app_user.update({
      where: { app_user_id: found.app_user_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async assignRole(loginId: string, dto: AssignRoleDto, actor?: bigint): Promise<user_role> {
    const [user, role] = await Promise.all([
      this.getUser(loginId),
      this.roles.getRole(dto.roleCode),
    ]);

    if (!role.is_active) {
      throw new BadRequestException(`비활성 역할은 부여할 수 없습니다: ${dto.roleCode}`);
    }

    orConflict(
      await this.prisma.user_role.findUnique({
        where: {
          app_user_id_role_id: { app_user_id: user.app_user_id, role_id: role.role_id },
        },
      }),
      `이미 부여된 역할입니다: ${loginId}.${dto.roleCode}`,
    );

    return this.prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id, created_by: actor },
    });
  }

  async findRoles(loginId: string): Promise<user_role[]> {
    const user = await this.getUser(loginId);
    return this.prisma.user_role.findMany({
      where: { app_user_id: user.app_user_id },
      include: { role: true },
    });
  }

  async revokeRole(loginId: string, roleCode: string): Promise<void> {
    const [user, role] = await Promise.all([this.getUser(loginId), this.roles.getRole(roleCode)]);

    const row = orFail(
      await this.prisma.user_role.findUnique({
        where: {
          app_user_id_role_id: { app_user_id: user.app_user_id, role_id: role.role_id },
        },
      }),
      `역할 배정(${loginId}.${roleCode})`,
    );

    await this.prisma.user_role.delete({ where: { user_role_id: row.user_role_id } });
  }

  /** 비활성 역할의 권한은 제외한다 — 역할을 끄면 권한도 꺼져야 한다. */
  async findEffectivePermissions(loginId: string): Promise<string[]> {
    const user = await this.getUser(loginId);

    const rows = await this.prisma.role_permission.findMany({
      where: {
        role: {
          is_active: true,
          user_role: { some: { app_user_id: user.app_user_id } },
        },
      },
      select: { permission_code: true },
      distinct: ['permission_code'],
      orderBy: { permission_code: 'asc' },
    });

    return rows.map((r) => r.permission_code);
  }

  async addDataScope(
    loginId: string,
    dto: AddDataScopeDto,
    actor?: bigint,
  ): Promise<user_data_scope> {
    const user = await this.getUser(loginId);

    if (!dto.businessUnitCode && !dto.plantCode) {
      throw new BadRequestException(
        '사업부(businessUnitCode)나 공장(plantCode) 중 최소 하나는 지정해야 합니다.',
      );
    }
    if (!dto.legalEntityCode) {
      throw new BadRequestException(
        '사업부·공장을 특정하려면 법인(legalEntityCode)이 필요합니다.',
      );
    }

    const businessUnitId = dto.businessUnitCode
      ? (await this.org.findBusinessUnit(dto.legalEntityCode, dto.businessUnitCode))
          .business_unit_id
      : null;
    const plantId = dto.plantCode
      ? (await this.org.findPlant(dto.legalEntityCode, dto.plantCode)).plant_id
      : null;

    // DB의 유니크 인덱스는 COALESCE(...)를 쓴다 — Prisma 모델로 표현되지 않으므로
    // 앱에서 먼저 확인한다. 경합으로 빠져나간 건은 DB가 막고 P2002 → 409로 변환된다.
    orConflict(
      await this.prisma.user_data_scope.findFirst({
        where: {
          app_user_id: user.app_user_id,
          business_unit_id: businessUnitId,
          plant_id: plantId,
        },
      }),
      `이미 부여된 접근범위입니다: ${loginId}`,
    );

    return this.prisma.user_data_scope.create({
      data: {
        app_user_id: user.app_user_id,
        business_unit_id: businessUnitId,
        plant_id: plantId,
        created_by: actor,
      },
    });
  }

  async findDataScopes(loginId: string): Promise<user_data_scope[]> {
    const user = await this.getUser(loginId);
    return this.prisma.user_data_scope.findMany({
      where: { app_user_id: user.app_user_id },
      orderBy: { user_data_scope_id: 'asc' },
    });
  }

  async removeDataScope(loginId: string, scopeId: bigint): Promise<void> {
    const user = await this.getUser(loginId);
    const row = orFail(
      await this.prisma.user_data_scope.findFirst({
        where: { user_data_scope_id: scopeId, app_user_id: user.app_user_id },
      }),
      `접근범위(${scopeId})`,
    );

    await this.prisma.user_data_scope.delete({
      where: { user_data_scope_id: row.user_data_scope_id },
    });
  }

  private async getUser(loginId: string): Promise<app_user> {
    return orFail(
      await this.prisma.app_user.findUnique({ where: { login_id: loginId } }),
      `사용자(${loginId})`,
    );
  }
}
