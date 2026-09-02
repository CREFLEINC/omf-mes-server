import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, filter, optional, referencePage, referenceWhere } from '../../common/master';

/** 계약 `Department` 와 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface DepartmentView {
  departmentId: number;
  departmentCode: string;
  departmentName: string;
  nameKo: string | null;
  nameVi: string | null;
  parentDepartmentId: number | null;
  businessUnitId: number | null;
  isActive: boolean;
  sourceSystemCode: string;
}

interface DepartmentWrite {
  departmentCode: string;
  departmentName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  parentDepartmentId?: number | null;
  businessUnitId?: number | null;
}

type DepartmentRow = Prisma.departmentGetPayload<object>;

export type DepartmentResult = {
  department: DepartmentView;
  editability: Editability;
  versionNo: number;
};

@Injectable()
export class DepartmentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ReferenceQuery & { businessUnitId?: number },
  ): Promise<PagedResponse<DepartmentView>> {
    const page = referencePage(query);
    const where = referenceWhere(
      query,
      { code: 'department_code', name: 'department_name' },
      filter('business_unit_id', query.businessUnitId),
    );
    const [rows, total] = await Promise.all([
      this.prisma.department.findMany({
        where,
        orderBy: { department_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.department.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(departmentId: number): Promise<DepartmentResult> {
    const row = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
    });
    if (!row) throw new NotFoundException('없는 부서입니다.');

    return {
      department: view(row),
      editability: await this.editability(row),
      versionNo: row.version_no,
    };
  }

  async create(input: DepartmentWrite): Promise<DepartmentView> {
    return view(
      await this.prisma.department.create({
        data: {
          department_code: input.departmentCode,
          department_name: input.departmentName,
          ...optional('name_ko', input.nameKo),
          ...optional('name_vi', input.nameVi),
          ...optional('parent_department_id', input.parentDepartmentId),
          ...optional('business_unit_id', input.businessUnitId),
          // 이 경로로 들어온 것은 정의상 MES 자체 등록분이다. ERP 수신본은 연계가 넣는다.
          source_system_code: 'MES',
        },
      }),
    );
  }

  async update(
    departmentId: number,
    version: number,
    input: DepartmentWrite,
  ): Promise<DepartmentResult> {
    await this.assertMesOwned(departmentId, '수정');
    if (input.parentDepartmentId != null) {
      await this.assertNoCycle(departmentId, input.parentDepartmentId);
    }

    const updated = await this.prisma.department.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { department_id: departmentId, version_no: version },
      data: {
        department_code: input.departmentCode,
        department_name: input.departmentName,
        ...optional('name_ko', input.nameKo),
        ...optional('name_vi', input.nameVi),
        ...optional('parent_department_id', input.parentDepartmentId),
        ...optional('business_unit_id', input.businessUnitId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(departmentId, updated.count);
    return this.get(departmentId);
  }

  async setActive(
    departmentId: number,
    version: number,
    isActive: boolean,
  ): Promise<DepartmentResult> {
    await this.assertMesOwned(departmentId, isActive ? '다시 사용' : '사용 중지');

    const updated = await this.prisma.department.updateMany({
      where: { department_id: departmentId, version_no: version },
      data: { is_active: isActive, version_no: { increment: 1 } },
    });
    await this.assertExists(departmentId, updated.count);
    return this.get(departmentId);
  }

  /**
   * 부서는 참조를 «셀 수 있다» — 가리키는 일곱 표가 전부 `department_id` FK 다.
   *
   * 코드 그룹과 갈리는 지점은 여기다. 그룹은 계약이 코드 «글자»를 리터럴로 지시해
   * 세지 못했지만(`#113`), 부서 코드를 글자로 부르는 자리는 계약에 **0곳**이다(실측).
   * 그래서 FK 건수가 곧 「이 코드를 고치면 곤란해지는 곳」의 수다.
   */
  private async editability(row: DepartmentRow): Promise<Editability> {
    if (row.source_system_code === 'ERP') {
      return { codeEditable: false, reason: 'RECEIVED_FROM_ERP', referenceCount: null };
    }
    // 일곱 자리는 «역할»이 서로 다르다(소속·결재자·담당·책임·상위). 잠금이 묻는 것은
    // 「이 부서를 가리키는 곳이 있는가」이므로 역할을 가리지 않고 전부 센다.
    const id = row.department_id;
    const counts = await Promise.all([
      this.prisma.app_user.count({ where: { department_id: id } }),
      this.prisma.worker.count({ where: { department_id: id } }),
      this.prisma.department.count({ where: { parent_department_id: id } }),
      this.prisma.approval_route_step.count({ where: { approver_department_id: id } }),
      this.prisma.exception_case.count({ where: { assigned_department_id: id } }),
      this.prisma.defect_record.count({ where: { responsible_department_id: id } }),
      this.prisma.nonconformance.count({ where: { responsible_department_id: id } }),
    ]);
    const referenceCount = counts.reduce((sum, n) => sum + n, 0);
    return {
      codeEditable: referenceCount === 0,
      reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
      referenceCount,
    };
  }

  /** ERP 수신본은 고칠 수 없다 — 고쳐도 다음 연계가 덮고, 그 사이 값이 갈린다. */
  private async assertMesOwned(departmentId: number, action: string): Promise<void> {
    const row = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { source_system_code: true },
    });
    if (!row) throw new NotFoundException('없는 부서입니다.');
    if (row.source_system_code === 'ERP') {
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: `기간계에서 받은 부서라 ${action}할 수 없습니다.`,
        },
      ]);
    }
  }

  /**
   * ⛔ `ck_department_parent` 는 「자기 자신이 부모」만 막는다. A→B→A 는 통과한다.
   * 순환이 서면 상위 부서를 타고 올라가는 모든 코드가 무한히 돈다 — 서버가 막는다.
   */
  private async assertNoCycle(departmentId: number, parentId: number): Promise<void> {
    const cycle: ErrorItem = {
      scope: 'field',
      field: 'parentDepartmentId',
      code: ERROR_CODE.INVALID,
      message: '상위 부서로 지정하면 부서 계층에 순환이 생깁니다.',
    };
    if (parentId === departmentId) throw new ContractException(HttpStatus.BAD_REQUEST, [cycle]);

    const seen = new Set<number>([departmentId]);
    let current: number | null = parentId;
    while (current !== null) {
      if (seen.has(current)) throw new ContractException(HttpStatus.BAD_REQUEST, [cycle]);
      seen.add(current);
      const row: { parent_department_id: bigint | null } | null =
        await this.prisma.department.findUnique({
          where: { department_id: current },
          select: { parent_department_id: true },
        });
      if (!row) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          {
            scope: 'field',
            field: 'parentDepartmentId',
            code: ERROR_CODE.INVALID,
            message: '없는 부서입니다.',
          },
        ]);
      }
      current = row.parent_department_id === null ? null : Number(row.parent_department_id);
    }
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(departmentId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { department_id: true },
    });
    if (!exists) throw new NotFoundException('없는 부서입니다.');
    assertUpdated(0);
  }
}

function view(row: DepartmentRow): DepartmentView {
  return {
    departmentId: Number(row.department_id),
    departmentCode: row.department_code,
    departmentName: row.department_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    parentDepartmentId: row.parent_department_id === null ? null : Number(row.parent_department_id),
    businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
    isActive: row.is_active,
    sourceSystemCode: row.source_system_code,
  };
}

