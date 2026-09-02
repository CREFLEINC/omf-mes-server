import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  Referrer,
  countReferences,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAdminRemains } from './last-admin';

/**
 * `app.role` 을 FK 로 가리키는 자리 전부. 실측(`pg_constraint`)이고 e2e 가 대조한다.
 *
 * ⚠ 계약 `Role` 은 「`role_permission`·`user_role` 의 FK 대상이라 셀 수 있다」고 둘만
 * 들었다. 그 둘은 이 화면이 «관리하는» 자리라 눈에 띈 것이고, 결재선 단계·판정유형 통제도
 * 같은 역할을 가리킨다. 잠금이 묻는 것은 「이 역할을 가리키는 곳이 있는가」이므로
 * 역할을 가리지 않고 넷을 다 센다(부서와 같은 판단 — `department.service.ts`).
 */
export const ROLE_REFERRERS: readonly Referrer[] = [
  ['app.approval_route_step', 'approver_role_id'],
  ['app.role_permission', 'role_id'],
  ['app.user_role', 'role_id'],
  ['mdm.judgment_type_control', 'approver_role_id'],
];

/** 계약 `Role` 과 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface RoleView {
  roleId: number;
  roleCode: string;
  roleName: string;
  description: string | null;
  isActive: boolean;
}

export interface RoleWrite {
  roleCode: string;
  roleName: string;
  description?: string | null;
}

type RoleRow = Prisma.roleGetPayload<object>;

export interface RoleResult {
  role: RoleView;
  editability: Editability;
  /** 사용 중지 확인 다이얼로그가 이 값을 쓴다(계약 `RoleDetailResponse`). */
  assignedUserCount: number;
  versionNo: number;
}

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ReferenceQuery): Promise<PagedResponse<RoleView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'role_code', name: 'role_name' });
    const [rows, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        orderBy: { role_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.role.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(roleId: number): Promise<RoleResult> {
    const row = await this.prisma.role.findUnique({ where: { role_id: roleId } });
    if (!row) throw new NotFoundException('없는 역할입니다.');

    const [referenceCount, assignedUserCount] = await Promise.all([
      countReferences(this.prisma, ROLE_REFERRERS, row.role_id),
      this.prisma.user_role.count({ where: { role_id: row.role_id } }),
    ]);

    return {
      role: view(row),
      editability: {
        codeEditable: referenceCount === 0,
        reason: referenceCount === 0 ? 'EDITABLE' : 'REFERENCED',
        referenceCount,
      },
      assignedUserCount,
      versionNo: row.version_no,
    };
  }

  async create(input: RoleWrite): Promise<RoleView> {
    assertPresent(input);
    await this.assertCodeFree(input.roleCode, null);

    return view(
      await this.prisma.role.create({
        data: {
          role_code: input.roleCode,
          role_name: input.roleName,
          ...optional('description', input.description),
        },
      }),
    );
  }

  async update(roleId: number, version: number, input: RoleWrite): Promise<RoleResult> {
    assertPresent(input);
    await this.assertCodeFree(input.roleCode, roleId);

    const updated = await this.prisma.role.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { role_id: roleId, version_no: version },
      data: {
        role_code: input.roleCode,
        role_name: input.roleName,
        ...optional('description', input.description),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(roleId, updated.count);
    return this.get(roleId);
  }

  /**
   * 계약이 물리 삭제를 두지 않아 되돌리는 경로가 이 하나다.
   *
   * ⛔ 중지는 **부여 기록을 지우지 않는다**(사용자 결정 2026-09-01) — 지우면 다시 켰을 때
   * 누구에게 줬는지가 사라진다. 대신 권한 «판정»에서 빠진다(`session.service.ts`).
   * 그래서 중지 한 번으로 관리자가 0명이 될 수 있고, 같은 트랜잭션에서 그것을 본다.
   */
  async setActive(roleId: number, version: number, isActive: boolean): Promise<RoleResult> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.updateMany({
        where: { role_id: roleId, version_no: version },
        data: { is_active: isActive, version_no: { increment: 1 } },
      });
      if (updated.count === 0) {
        const exists = await tx.role.findUnique({
          where: { role_id: roleId },
          select: { role_id: true },
        });
        if (!exists) throw new NotFoundException('없는 역할입니다.');
        assertUpdated(0);
      }
      // 켜는 쪽은 관리자를 늘리기만 한다 — 볼 이유가 없다.
      if (!isActive) await assertAdminRemains(tx);
    });

    return this.get(roleId);
  }

  /**
   * `role_role_code_key` 를 미리 본다 — 부딪히게 두면 500 이 나가고, 계약은 이 자리에
   * 400 과 **유일키 범위**를 요구한다(공유계약 A-1 — 범위가 없으면 화면이 문구를 못 만든다).
   */
  private async assertCodeFree(roleCode: string, self: number | null): Promise<void> {
    const taken = await this.prisma.role.findUnique({
      where: { role_code: roleCode },
      select: { role_id: true },
    });
    if (!taken || (self !== null && Number(taken.role_id) === self)) return;

    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'roleCode',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['roleCode'],
        message: '이미 있는 역할코드입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(roleId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.role.findUnique({
      where: { role_id: roleId },
      select: { role_id: true },
    });
    if (!exists) throw new NotFoundException('없는 역할입니다.');
    assertUpdated(0);
  }
}

/**
 * 계약이 두 칸에 「공백만 불가」로 적었다. 계약 검증 가드는 타입·길이만 보므로
 * `" "` 는 통과한다 — 그대로 저장하면 목록에서 이름이 없는 역할이 된다.
 */
function assertPresent(input: RoleWrite): void {
  const errors: ErrorItem[] = (
    [
      ['roleCode', input.roleCode],
      ['roleName', input.roleName],
    ] as const
  )
    .filter(([, value]) => value.trim() === '')
    .map(([field]) => ({
      scope: 'field' as const,
      field,
      code: ERROR_CODE.REQUIRED,
      message: '공백만으로는 채울 수 없습니다.',
    }));
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function view(row: RoleRow): RoleView {
  return {
    roleId: Number(row.role_id),
    roleCode: row.role_code,
    roleName: row.role_name,
    description: row.description,
    isActive: row.is_active,
  };
}
