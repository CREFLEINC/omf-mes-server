import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractBadRequest, ErrorCode, screenError } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { toEditability } from '../editability';
import { countReferences } from '../reference-count';
import { checkActivable, checkDeactivable } from './department.activation';
import { CreateDepartmentDto } from './department.create.dto';
import { toDepartment } from './department.mapper';
import { DepartmentQueryDto } from './department.query.dto';
import { DEPARTMENT_REFERENCES } from './department.references';
import { UpdateDepartmentDto } from './department.update.dto';
import { DepartmentValidator } from './department.validator';

type DepartmentList = {
  items: components['schemas']['Department'][];
  page: components['schemas']['PageMeta'];
};

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 분기는 컨트롤러가 한다. */
type DepartmentDetail = {
  body: components['schemas']['DepartmentDetailResponse'];
  versionNo: number;
};

/** 쓰기 응답. `versionNo` 는 같은 이유로 본문이 아니라 ETag 로 나간다. */
type DepartmentWritten = {
  body: components['schemas']['Department'];
  versionNo: number;
};

@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: DepartmentValidator,
  ) {}

  async create(
    dto: CreateDepartmentDto,
    actorId: bigint,
  ): Promise<components['schemas']['Department']> {
    const errors = await this.validator.validateCreate(dto);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    const row = await this.prisma.department.create({
      data: {
        ...this.writableFields(dto),
        // is_active 는 받지 않는다 — 신규는 항상 사용 중이다(계약 DepartmentCreate).
        created_by: actorId,
        updated_by: actorId,
      },
    });

    return toDepartment(row);
  }

  async update(
    departmentId: bigint,
    expectedVersion: number,
    dto: UpdateDepartmentDto,
    actorId: bigint,
  ): Promise<DepartmentWritten> {
    const current = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { department_code: true },
    });
    if (!current) throw new NotFoundException(`부서(${departmentId})를 찾을 수 없습니다.`);

    const errors = await this.validator.validateUpdate(
      departmentId,
      current.department_code,
      dto,
    );
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(departmentId, expectedVersion, actorId, this.writableFields(dto));
  }

  /**
   * 물리 삭제는 제공하지 않는다 — 과거 기록이 이 부서를 가리키고 있어, 지우면 그 기록이
   * 어느 부서를 가리키는지 알 수 없어진다.
   */
  async deactivate(
    departmentId: bigint,
    expectedVersion: number,
    actorId: bigint,
  ): Promise<DepartmentWritten> {
    const current = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { is_active: true },
    });
    if (!current) throw new NotFoundException(`부서(${departmentId})를 찾을 수 없습니다.`);

    // STATE_LOCKED 인 이유: 새로고침해도 풀리지 않는다. 하위 부서를 중지하거나 사람의
    // 소속을 옮겨야 풀리므로, 재로드로 풀리는 저장 충돌(409)과 다르다(공유계약 G-1).
    const errors = current.is_active
      ? await checkDeactivable(this.prisma, departmentId)
      : [screenError(ErrorCode.STATE_LOCKED, '이미 중지된 부서입니다.')];
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(departmentId, expectedVersion, actorId, { is_active: false });
  }

  /** 계약에 없다 — 창고·로케이션의 `:activate` 와 같은 이유로 서버가 먼저 만든다. */
  async activate(
    departmentId: bigint,
    expectedVersion: number,
    actorId: bigint,
  ): Promise<DepartmentWritten> {
    const current = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { is_active: true, parent_department_id: true, business_unit_id: true },
    });
    if (!current) throw new NotFoundException(`부서(${departmentId})를 찾을 수 없습니다.`);

    const errors = current.is_active
      ? [screenError(ErrorCode.STATE_LOCKED, '이미 사용 중인 부서입니다.')]
      : await checkActivable(this.prisma, current);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    return this.applyVersioned(departmentId, expectedVersion, actorId, { is_active: true });
  }

  /**
   * 등록과 수정이 같은 필드를 쓴다 — `PUT` 이 전체 교체라서다. 한쪽에만 필드를 더하면
   * 수정으로는 못 넣는 값이 생긴다. 선택 필드는 안 보내면 `null` 로 지운다.
   */
  private writableFields(dto: CreateDepartmentDto | UpdateDepartmentDto) {
    return {
      department_code: dto.departmentCode,
      department_name: dto.departmentName,
      parent_department_id: dto.parentDepartmentId ? BigInt(dto.parentDepartmentId) : null,
      business_unit_id: dto.businessUnitId ? BigInt(dto.businessUnitId) : null,
    };
  }

  /**
   * 낙관적 잠금은 **조건부 갱신**으로 건다 — WHERE 에 기대 버전을 넣어 행 단위
   * 비교-교환으로 만든다(공유계약 B-1). 창고·로케이션과 같은 규칙이다.
   */
  private async applyVersioned(
    departmentId: bigint,
    expectedVersion: number,
    actorId: bigint,
    data: Prisma.departmentUncheckedUpdateManyInput,
  ): Promise<DepartmentWritten> {
    const { count } = await this.prisma.department.updateMany({
      where: { department_id: departmentId, version_no: expectedVersion },
      data: { ...data, updated_by: actorId, updated_at: new Date(), version_no: { increment: 1 } },
    });

    if (count === 0) {
      // erpSync·workerLease 는 판정할 근거가 스키마에 없다.
      throw new ConflictException({
        conflictCause: 'user',
        message: '다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하십시오.',
      });
    }

    const row = await this.prisma.department.findUniqueOrThrow({
      where: { department_id: departmentId },
    });

    return { body: toDepartment(row), versionNo: row.version_no };
  }

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
