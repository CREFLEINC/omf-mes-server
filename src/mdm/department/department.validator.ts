import { Injectable } from '@nestjs/common';

import { ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';
import { checkCodeLock } from '../editability';
import { CreateDepartmentDto } from './department.create.dto';
import { DEPARTMENT_REFERENCES } from './department.references';
import { UpdateDepartmentDto } from './department.update.dto';

/**
 * 부모를 따라 올라가는 최대 깊이. 실제 조직은 본부→팀→반 정도다.
 * 이 값은 **이미 순환이 든 데이터를 만났을 때 질의가 멈추게 하는 안전장치**다.
 */
const MAX_DEPTH = 64;

type DepartmentDto = CreateDepartmentDto | UpdateDepartmentDto;

@Injectable()
export class DepartmentValidator {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 검사를 `Promise.all` 로 동시에 돌린다 — 성공이 보통이고 성공은 어차피 전부
   * 확인해야 한다(L2 에서 정한 판단).
   */
  async validateCreate(dto: CreateDepartmentDto): Promise<ErrorItem[]> {
    const [businessUnit, parent, duplicate] = await Promise.all([
      this.checkBusinessUnit(dto),
      this.checkParent(dto.parentDepartmentId, null),
      this.checkDuplicate(dto.departmentCode, null),
    ]);

    return [...businessUnit, ...parent, ...duplicate];
  }

  async validateUpdate(
    departmentId: bigint,
    currentCode: string,
    dto: UpdateDepartmentDto,
  ): Promise<ErrorItem[]> {
    const [businessUnit, parent, duplicate, codeLock] = await Promise.all([
      this.checkBusinessUnit(dto),
      this.checkParent(dto.parentDepartmentId, departmentId),
      this.checkDuplicate(dto.departmentCode, departmentId),
      checkCodeLock(
        this.prisma,
        DEPARTMENT_REFERENCES,
        departmentId,
        'departmentCode',
        currentCode,
        dto.departmentCode,
      ),
    ]);

    return [...businessUnit, ...parent, ...duplicate, ...codeLock];
  }

  /** 사업부는 선택이다. 보냈으면 실재하고 사용 중이어야 한다. */
  private async checkBusinessUnit(dto: DepartmentDto): Promise<ErrorItem[]> {
    if (dto.businessUnitId === undefined || dto.businessUnitId === null) return [];

    const found = await this.prisma.business_unit.findUnique({
      where: { business_unit_id: BigInt(dto.businessUnitId) },
      select: { is_active: true },
    });

    if (!found) return [fieldError('businessUnitId', ErrorCode.RANGE, '없는 사업부입니다.')];

    return found.is_active
      ? []
      : [
          fieldError(
            'businessUnitId',
            ErrorCode.STATE_LOCKED,
            '중지된 사업부에는 부서를 둘 수 없습니다.',
          ),
        ];
  }

  /**
   * 상위 부서는 실재해야 하고, 거슬러 올라가도 자기 자신이 나오면 안 된다.
   *
   * `departmentId` 가 `null` 이면 등록이다 — 아직 행이 없어 자기 자신에 걸릴 수 없지만
   * 깊이 검사는 그대로 돈다(이미 순환이 든 계층 아래에 매달면 위로 가는 길이 안 끝난다).
   */
  private async checkParent(
    parentDepartmentId: number | null | undefined,
    departmentId: bigint | null,
  ): Promise<ErrorItem[]> {
    if (parentDepartmentId === undefined || parentDepartmentId === null) return [];

    const parent = await this.prisma.department.findUnique({
      where: { department_id: BigInt(parentDepartmentId) },
      select: { department_id: true },
    });
    if (!parent) return [fieldError('parentDepartmentId', ErrorCode.RANGE, '없는 부서입니다.')];

    return this.checkCycle(departmentId, BigInt(parentDepartmentId));
  }

  /**
   * DB 는 자기 자신만 막는다 — `ck_department_parent`(`parent <> id`). **순환은 못 막는다.**
   * `A→B→A` 는 각 행만 보면 정상이라 제약으로 표현할 수 없다. 계약도 「서버가 검사한다」로
   * 적었다.
   *
   * 재귀 CTE 로 한 번에 묻는다. 애플리케이션에서 한 단계씩 올라가면 깊이만큼 왕복하고,
   * 이미 순환이 든 데이터를 만나면 영원히 멈추지 않는다.
   */
  private async checkCycle(
    departmentId: bigint | null,
    parentDepartmentId: bigint,
  ): Promise<ErrorItem[]> {
    const chain = await this.prisma.$queryRaw<{ department_id: bigint; depth: number }[]>`
      WITH RECURSIVE chain AS (
        SELECT department_id, parent_department_id, 1 AS depth
        FROM mdm.department
        WHERE department_id = ${parentDepartmentId}
        UNION ALL
        SELECT d.department_id, d.parent_department_id, chain.depth + 1
        FROM mdm.department d
        JOIN chain ON d.department_id = chain.parent_department_id
        WHERE chain.depth < ${MAX_DEPTH}
      )
      SELECT department_id, depth FROM chain
    `;

    if (departmentId !== null && chain.some((row) => row.department_id === departmentId)) {
      return [
        fieldError(
          'parentDepartmentId',
          ErrorCode.RANGE,
          '자기 자신이나 하위 부서를 상위로 지정할 수 없습니다.',
        ),
      ];
    }

    // 깊이 한계에 닿으면 위쪽에 이미 순환이 있다. 자기 자신이 그 고리에 없더라도
    // 매달면 안 된다 — 붙는 순간 이 부서도 못 빠져나온다.
    return chain.some((row) => row.depth >= MAX_DEPTH)
      ? [
          fieldError(
            'parentDepartmentId',
            ErrorCode.RANGE,
            '상위 계층이 너무 깊거나 순환되어 있습니다. 상위 부서를 먼저 정리하십시오.',
          ),
        ]
      : [];
  }

  /**
   * `department_code_key` — **전역 유일**이다. 창고(공장 안)·로케이션(창고 안)과 다르다.
   *
   * 선제 조회일 뿐이라 동시 요청은 통과할 수 있다. 최종 방어는 DB 제약이고
   * `PrismaExceptionFilter` 가 같은 봉투로 바꾼다.
   */
  private async checkDuplicate(
    departmentCode: string,
    departmentId: bigint | null,
  ): Promise<ErrorItem[]> {
    const existing = await this.prisma.department.findUnique({
      where: { department_code: departmentCode },
      select: { department_id: true },
    });

    if (!existing) return [];

    return existing.department_id === departmentId ? [] : [duplicateDepartmentCode()];
  }
}

/** 선제 조회와 DB 제약 위반이 같은 문구를 내려야 한다 — 화면이 둘을 구분할 이유가 없다. */
export function duplicateDepartmentCode(): ErrorItem {
  return fieldError('departmentCode', ErrorCode.UNIQUE_VIOLATION, '이미 있는 부서 코드입니다.', [
    'departmentCode',
  ]);
}
