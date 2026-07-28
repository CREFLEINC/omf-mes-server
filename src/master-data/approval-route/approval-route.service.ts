import { BadRequestException, Injectable } from '@nestjs/common';
import {
  app_user,
  approval_route,
  approval_route_step,
  business_unit,
  department,
  Prisma,
  role,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  orFail,
  updateStamp,
} from '../common/master-crud';
import {
  ApprovalRouteQueryDto,
  CreateApprovalRouteDto,
  CreateApprovalRouteStepDto,
  UpdateApprovalRouteDto,
} from './approval-route.dto';

/** 승인자 지정 방식별로 채워야 하는 필드. DDL은 셋 중 정확히 하나만 허용한다. */
const APPROVER_FIELD: Record<string, keyof CreateApprovalRouteStepDto> = {
  USER: 'approverLoginId',
  ROLE: 'approverRoleCode',
  DEPARTMENT: 'approverDepartmentCode',
};

@Injectable()
export class ApprovalRouteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateApprovalRouteDto, actor?: bigint): Promise<approval_route> {
    await this.codes.assertValid('APPROVAL_TYPE', dto.approvalTypeCode);
    this.assertValueRange(dto.minValue, dto.maxValue);

    const businessUnit = dto.businessUnitCode
      ? await this.getBusinessUnit(dto.businessUnitCode)
      : null;

    return this.prisma.approval_route.create({
      data: {
        approval_type_code: dto.approvalTypeCode,
        business_unit_id: businessUnit?.business_unit_id ?? null,
        min_value: dto.minValue ?? null,
        max_value: dto.maxValue ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: ApprovalRouteQueryDto): Promise<PageDto<approval_route>> {
    const extra: Prisma.approval_routeWhereInput = {};
    if (query.approvalTypeCode) extra.approval_type_code = query.approvalTypeCode;

    const where = baseWhere(query, ['approval_type_code'], extra) as Prisma.approval_routeWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.approval_route.findMany({
        where,
        include: {
          business_unit: { select: { business_unit_code: true } },
          approval_route_step: { orderBy: { step_no: 'asc' } },
        },
        orderBy: [{ approval_type_code: 'asc' }, { min_value: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.approval_route.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(routeId: bigint) {
    const found = await this.prisma.approval_route.findUnique({
      where: { approval_route_id: routeId },
      include: {
        business_unit: { select: { business_unit_code: true } },
        approval_route_step: {
          orderBy: { step_no: 'asc' },
          include: {
            app_user: { select: { login_id: true, user_name: true } },
            role: { select: { role_code: true, role_name: true } },
            department: { select: { department_code: true, department_name: true } },
          },
        },
      },
    });
    return orFail(found, `결재선(${routeId})`);
  }

  async update(
    routeId: bigint,
    dto: UpdateApprovalRouteDto,
    actor?: bigint,
  ): Promise<approval_route> {
    const found = await this.getRoute(routeId);
    this.assertValueRange(
      dto.minValue ?? found.min_value?.toNumber(),
      dto.maxValue ?? found.max_value?.toNumber(),
    );

    const businessUnitId = dto.businessUnitCode
      ? (await this.getBusinessUnit(dto.businessUnitCode)).business_unit_id
      : undefined;

    return this.prisma.approval_route.update({
      where: { approval_route_id: found.approval_route_id },
      data: {
        business_unit_id: businessUnitId,
        min_value: dto.minValue,
        max_value: dto.maxValue,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(routeId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getRoute(routeId);

    await this.prisma.approval_route.update({
      where: { approval_route_id: found.approval_route_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async addStep(
    routeId: bigint,
    dto: CreateApprovalRouteStepDto,
    actor?: bigint,
  ): Promise<approval_route_step> {
    const found = await this.getRoute(routeId);
    await this.codes.assertValid('APPROVER_TYPE', dto.approverTypeCode);
    this.assertSingleTarget(dto);

    const target = await this.resolveTarget(dto);

    orConflict(
      await this.prisma.approval_route_step.findUnique({
        where: {
          approval_route_id_step_no: {
            approval_route_id: found.approval_route_id,
            step_no: dto.stepNo,
          },
        },
      }),
      `이미 존재하는 결재 순서입니다: ${dto.stepNo}`,
    );

    return this.prisma.approval_route_step.create({
      data: {
        approval_route_id: found.approval_route_id,
        step_no: dto.stepNo,
        approver_type_code: dto.approverTypeCode,
        approver_user_id: target.userId ?? null,
        approver_role_id: target.roleId ?? null,
        approver_department_id: target.departmentId ?? null,
        created_by: actor,
      },
    });
  }

  async findSteps(routeId: bigint): Promise<approval_route_step[]> {
    const found = await this.getRoute(routeId);
    return this.prisma.approval_route_step.findMany({
      where: { approval_route_id: found.approval_route_id },
      include: {
        app_user: { select: { login_id: true, user_name: true } },
        role: { select: { role_code: true, role_name: true } },
        department: { select: { department_code: true, department_name: true } },
      },
      orderBy: { step_no: 'asc' },
    });
  }

  /** 단계에는 수정 이력 컬럼이 없다 — 바꾸려면 지우고 다시 넣는다. */
  async removeStep(routeId: bigint, stepNo: number): Promise<void> {
    const found = await this.getRoute(routeId);
    const step = orFail(
      await this.prisma.approval_route_step.findUnique({
        where: {
          approval_route_id_step_no: { approval_route_id: found.approval_route_id, step_no: stepNo },
        },
      }),
      `결재 단계(순서 ${stepNo})`,
    );

    await this.prisma.approval_route_step.delete({
      where: { approval_route_step_id: step.approval_route_step_id },
    });
  }

  /** DDL ck_approval_route_range — 상한이 하한보다 작으면 어떤 금액도 이 라우트를 타지 못한다. */
  private assertValueRange(min?: number | null, max?: number | null): void {
    if (min !== undefined && min !== null && max !== undefined && max !== null && max < min) {
      throw new BadRequestException('금액구간 상한은 하한보다 작을 수 없습니다.');
    }
  }

  /**
   * DDL ck_approval_route_step_target — 승인자 대상은 정확히 하나다.
   * 방식과 채운 필드가 어긋나면(ROLE인데 로그인ID) DB 제약은 통과하지만 의도와 다르게 동작한다.
   */
  private assertSingleTarget(dto: CreateApprovalRouteStepDto): void {
    const given = (
      ['approverLoginId', 'approverRoleCode', 'approverDepartmentCode'] as const
    ).filter((field) => dto[field] !== undefined && dto[field] !== null);

    if (given.length !== 1) {
      throw new BadRequestException(
        `승인자는 사용자·역할·부서 중 정확히 하나로 지정해야 합니다. 지정: ${given.length}개`,
      );
    }

    const expected = APPROVER_FIELD[dto.approverTypeCode];
    if (!expected) {
      throw new BadRequestException(
        `알 수 없는 승인자 지정 방식입니다: ${dto.approverTypeCode} (USER·ROLE·DEPARTMENT)`,
      );
    }
    if (given[0] !== expected) {
      throw new BadRequestException(
        `승인자 지정 방식이 ${dto.approverTypeCode}이면 ${expected}를 채워야 합니다.`,
      );
    }
  }

  private async resolveTarget(dto: CreateApprovalRouteStepDto) {
    if (dto.approverLoginId) {
      const user = await this.getUser(dto.approverLoginId);
      return { userId: user.app_user_id };
    }
    if (dto.approverRoleCode) {
      const role = await this.getRole(dto.approverRoleCode);
      return { roleId: role.role_id };
    }
    const department = await this.getDepartment(dto.approverDepartmentCode as string);
    return { departmentId: department.department_id };
  }

  private async getRoute(routeId: bigint): Promise<approval_route> {
    return orFail(
      await this.prisma.approval_route.findUnique({ where: { approval_route_id: routeId } }),
      `결재선(${routeId})`,
    );
  }

  private async getBusinessUnit(businessUnitCode: string): Promise<business_unit> {
    const rows = await this.prisma.business_unit.findMany({
      where: { business_unit_code: businessUnitCode },
      take: 2,
    });
    return exactlyOne(rows, '사업부', businessUnitCode);
  }

  private async getUser(loginId: string): Promise<app_user> {
    return orFail(
      await this.prisma.app_user.findUnique({ where: { login_id: loginId } }),
      `사용자(${loginId})`,
    );
  }

  private async getRole(roleCode: string): Promise<role> {
    return orFail(
      await this.prisma.role.findUnique({ where: { role_code: roleCode } }),
      `역할(${roleCode})`,
    );
  }

  private async getDepartment(departmentCode: string): Promise<department> {
    const rows = await this.prisma.department.findMany({
      where: { department_code: departmentCode },
      take: 2,
    });
    return exactlyOne(rows, '부서', departmentCode);
  }
}
