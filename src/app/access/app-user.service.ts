import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import {
  Editability,
  ReferenceQuery,
  assertCodeValues,
  assertNotBlank,
  filter,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAdminRemains } from './last-admin';

/**
 * `loginId` 는 **언제나 잠긴다.**
 *
 * 공유계약 `B-4` 는 「참조 건수가 0일 때만 코드 수정 허용」인데, `login_id` 를 가리키는
 * 자리는 `created_by`·`updated_by` 류로 흩어져 있고 그쪽에 FK 를 «의도적으로» 걸지 않았다.
 * 셀 수 없는 조건은 규칙이 될 수 없다 — 그래서 `NOT_COUNTABLE` 로 잠근다(계약 `AppUser`).
 * 바꿔야 하면 새 계정을 만든다(사용자 결정 2026-09-01 · `W-CO-02` §8-5 해소).
 */
const LOGIN_ID_EDITABILITY: Editability = {
  codeEditable: false,
  reason: 'NOT_COUNTABLE',
  referenceCount: null,
};

/** 계약 `AppUser` 와 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface AppUserView {
  appUserId: number;
  loginId: string;
  userName: string;
  departmentId: number | null;
  email: string | null;
  statusCode: string;
  isActive: boolean;
}

export interface AppUserCreate {
  loginId: string;
  userName: string;
  departmentId?: number | null;
  email?: string | null;
  statusCode?: string;
}

export interface AppUserUpdate {
  userName: string;
  statusCode: string;
  departmentId?: number | null;
  email?: string | null;
}

export interface AppUserQuery extends ReferenceQuery {
  departmentId?: number;
  statusCode?: string;
}

type AppUserRow = Prisma.app_userGetPayload<object>;

export interface AppUserResult {
  appUser: AppUserView;
  editability: Editability;
  versionNo: number;
}

@Injectable()
export class AppUserService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AppUserQuery): Promise<PagedResponse<AppUserView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'login_id', name: 'user_name' }, {
      ...filter('department_id', query.departmentId),
      // ⛔ 인사 상태 필터다. 계정을 쓸 수 있는가(`is_active`)와는 다른 축이라
      // `includeInactive` 와 겹치지 않는다 — 휴직인데 계정은 살아 있는 경우가 실재한다.
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.app_user.findMany({
        where,
        orderBy: { login_id: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.app_user.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(appUserId: number): Promise<AppUserResult> {
    const row = await this.prisma.app_user.findUnique({ where: { app_user_id: appUserId } });
    if (!row) throw new NotFoundException('없는 사용자입니다.');
    return { appUser: view(row), editability: LOGIN_ID_EDITABILITY, versionNo: row.version_no };
  }

  async create(input: AppUserCreate): Promise<AppUserView> {
    assertNotBlank([
      ['loginId', input.loginId],
      ['userName', input.userName],
    ]);
    await this.assertReferences(input.statusCode, input.departmentId);
    await this.assertLoginIdFree(input.loginId);

    return view(
      await this.prisma.app_user.create({
        data: {
          login_id: input.loginId,
          user_name: input.userName,
          ...optional('department_id', input.departmentId),
          ...optional('email', input.email),
          // 안 보내면 물리 모델 DEFAULT('ACTIVE')가 채운다(계약).
          ...optional('status_code', input.statusCode),
        },
      }),
    );
  }

  /** ⛔ `loginId` 는 본문에 없다 — 한 번 만들면 고치지 않는다(계약 `AppUserUpdate`). */
  async update(appUserId: number, version: number, input: AppUserUpdate): Promise<AppUserResult> {
    assertNotBlank([['userName', input.userName]]);
    await this.assertReferences(input.statusCode, input.departmentId);

    const updated = await this.prisma.app_user.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { app_user_id: appUserId, version_no: version },
      data: {
        user_name: input.userName,
        status_code: input.statusCode,
        ...optional('department_id', input.departmentId),
        ...optional('email', input.email),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(appUserId, updated.count);
    return this.get(appUserId);
  }

  /**
   * ⭐ **자기 자신도 막는다**(사용자 결정 2026-09-01 「둘 다 막는다」). 관리자 교체는
   * «다른 관리자»가 한다 — 새 관리자를 먼저 세우고 기존 관리자를 내린다.
   * ⚠ 그래서 운영은 관리자를 **둘 이상** 두어야 한다. 하나뿐이면 내릴 방법이 없다.
   */
  async setActive(appUserId: number, version: number, isActive: boolean): Promise<AppUserResult> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.app_user.updateMany({
        where: { app_user_id: appUserId, version_no: version },
        data: { is_active: isActive, version_no: { increment: 1 } },
      });
      if (updated.count === 0) {
        const exists = await tx.app_user.findUnique({
          where: { app_user_id: appUserId },
          select: { app_user_id: true },
        });
        if (!exists) throw new NotFoundException('없는 사용자입니다.');
        assertUpdated(0);
      }
      // 켜는 쪽은 관리자를 늘리기만 한다 — 볼 이유가 없다.
      if (!isActive) await assertAdminRemains(tx);
    });

    return this.get(appUserId);
  }

  private async assertReferences(
    statusCode: string | undefined,
    departmentId: number | null | undefined,
  ): Promise<void> {
    // ⛔ 값 목록을 하드코딩하지 않는다 — 계약이 코드 그룹으로 받으라 적었다(G-31·G-32).
    await assertCodeValues(this.prisma, [
      { field: 'statusCode', value: statusCode, groupCode: 'APP_USER_STATUS' },
    ]);
    if (departmentId == null) return;

    const department = await this.prisma.department.findUnique({
      where: { department_id: departmentId },
      select: { department_id: true },
    });
    if (department) return;
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'departmentId',
        code: ERROR_CODE.INVALID,
        message: '없는 부서입니다.',
      },
    ]);
  }

  /**
   * `app_user_login_id_key` 를 미리 본다 — 부딪히게 두면 500 이 나가고, 계약은 이 자리에
   * 400 과 **유일키 범위**를 요구한다(공유계약 A-1).
   */
  private async assertLoginIdFree(loginId: string): Promise<void> {
    const taken = await this.prisma.app_user.findUnique({
      where: { login_id: loginId },
      select: { app_user_id: true },
    });
    if (!taken) return;

    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'field',
        field: 'loginId',
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['loginId'],
        message: '이미 있는 로그인ID 입니다.',
      },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(appUserId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.app_user.findUnique({
      where: { app_user_id: appUserId },
      select: { app_user_id: true },
    });
    if (!exists) throw new NotFoundException('없는 사용자입니다.');
    assertUpdated(0);
  }
}

function view(row: AppUserRow): AppUserView {
  return {
    appUserId: Number(row.app_user_id),
    loginId: row.login_id,
    userName: row.user_name,
    departmentId: row.department_id === null ? null : Number(row.department_id),
    email: row.email,
    statusCode: row.status_code,
    isActive: row.is_active,
  };
}
