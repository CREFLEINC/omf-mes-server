import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { hashPassword, generateTemporaryPassword } from '../../auth/password';
import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { assertAdminRemains } from './last-admin';

/** 계약 `UserRole` 과 동형. */
interface UserRoleView {
  userRoleId: number;
  appUserId: number;
  roleId: number;
}

/** 계약 `UserDataScope` 와 동형. */
interface UserDataScopeView {
  userDataScopeId: number;
  appUserId: number;
  businessUnitId: number | null;
  plantId: number | null;
}

export interface ScopeInput {
  businessUnitId?: number | null;
  plantId?: number | null;
}

/** 계약 `AppUserPasswordReset` 과 동형. */
export interface PasswordReset {
  appUserId: number;
  temporaryPassword: string;
  resetAt: string;
}

@Injectable()
export class UserAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 역할 배정 ───────────────────────────────────────────────────────────

  async listRoles(appUserId: number): Promise<UserRoleView[]> {
    await this.assertUser(appUserId);
    return this.readRoles(appUserId);
  }

  /**
   * 「최종 상태를 통째로 보낸다 — 체크박스 화면이 서버와 어긋날 여지가 없다」(계약 · `B-6`).
   *
   * ⛔ 「동시에 같은 역할이 부여되는 경합은 유일 위반으로 거부하지 않고 **이미 반영된
   * 상태로 조용히 갱신**한다」(계약 §6). 지우고 다시 넣는 치환이라 그 경합은 자연히
   * 흡수된다 — 마지막에 커밋한 쪽의 목록이 남고, 둘 다 같은 목록을 보냈으면 결과가 같다.
   *
   * ⛔ 치환 뒤에 관리자를 센다 — 이 사용자에게서 관리자 역할을 빼면 0명이 될 수 있다.
   */
  async replaceRoles(
    appUserId: number,
    roleIds: number[],
    actorId?: number,
  ): Promise<UserRoleView[]> {
    await this.assertUser(appUserId);
    // 배정은 집합이다(`uq_user_role`) — 중복은 오류가 아니라 같은 뜻이라 접어서 받는다.
    const unique = [...new Set(roleIds)];
    await this.assertRolesExist(unique);

    await this.prisma.$transaction(async (tx) => {
      await tx.user_role.deleteMany({ where: { app_user_id: appUserId } });
      if (unique.length > 0) {
        await tx.user_role.createMany({
          data: unique.map((roleId) => ({
            app_user_id: appUserId,
            role_id: roleId,
            ...(actorId === undefined ? {} : { created_by: actorId }),
          })),
        });
      }
      await assertAdminRemains(tx);
    });

    return this.readRoles(appUserId);
  }

  // ── 데이터 접근범위 ─────────────────────────────────────────────────────

  async listScopes(appUserId: number): Promise<UserDataScopeView[]> {
    await this.assertUser(appUserId);
    return this.readScopes(appUserId);
  }

  /**
   * ⚠ 역할과 달리 **중복을 접지 않고 거절한다.** 계약이 그렇게 정했다 — 「같은 범위를 두 번
   * 넣으면 400(UNIQUE_VIOLATION)」. 범위는 축이 둘이라 「(전체)로 비운 축」이 눈에 안 보여,
   * 조용히 접으면 화면이 두 줄을 그려 놓고 하나만 저장된 것을 모른다.
   */
  async replaceScopes(
    appUserId: number,
    scopes: ScopeInput[],
    actorId?: number,
  ): Promise<UserDataScopeView[]> {
    await this.assertUser(appUserId);
    assertScopeShape(scopes);
    await this.assertScopeTargets(scopes);

    await this.prisma.$transaction(async (tx) => {
      await tx.user_data_scope.deleteMany({ where: { app_user_id: appUserId } });
      if (scopes.length > 0) {
        await tx.user_data_scope.createMany({
          data: scopes.map((scope) => ({
            app_user_id: appUserId,
            business_unit_id: scope.businessUnitId ?? null,
            plant_id: scope.plantId ?? null,
            ...(actorId === undefined ? {} : { created_by: actorId }),
          })),
        });
      }
    });

    return this.readScopes(appUserId);
  }

  // ── 비밀번호 관리자 초기화 ──────────────────────────────────────────────

  /**
   * 「임시 비밀번호를 생성해 이 응답에서 **한 번만** 보인다 — 저장하지 않는다」(계약).
   *
   * ⛔ 자격증명 행이 «없을 수» 있다 — `POST /app/users` 는 비밀번호를 받지 않으므로 갓
   * 만든 계정은 해시가 없다. 그래서 upsert 다: 초기화가 첫 비밀번호를 세우는 경로이기도 하다.
   *
   * ⛔ 실패 횟수와 잠금을 함께 푼다. 계약이 「잠긴 계정은 스스로 풀 수 없다. 관리자가
   * 푼다」라고 적었고, 관리자가 푸는 경로가 이것뿐이다 — 여기서 안 풀면 잠긴 계정은
   * 새 비밀번호를 받고도 못 들어온다.
   */
  async resetPassword(appUserId: number, actorId?: number): Promise<PasswordReset> {
    await this.assertUser(appUserId);
    const temporaryPassword = generateTemporaryPassword();
    const password_hash = await hashPassword(temporaryPassword);
    const resetAt = new Date();

    const changed = {
      password_hash,
      password_changed_at: resetAt,
      // 임시 비밀번호이므로 바꾸게 표시해 둔다. ⚠ 지금 이 값을 읽어 «강제»하는 화면은
      // 아직 없다(`POST /app/users/me:change-password` 미구현) — 그때 이 표시가 쓰인다.
      must_change_password: true,
      failed_attempt_count: 0,
      locked_until: null,
      ...(actorId === undefined ? {} : { updated_by: actorId }),
    };
    await this.prisma.user_credential.upsert({
      where: { app_user_id: appUserId },
      update: changed,
      create: {
        app_user_id: appUserId,
        ...changed,
        ...(actorId === undefined ? {} : { created_by: actorId }),
      },
    });

    return { appUserId, temporaryPassword, resetAt: resetAt.toISOString() };
  }

  // ── 읽기·검사 ───────────────────────────────────────────────────────────

  private async readRoles(appUserId: number): Promise<UserRoleView[]> {
    const rows = await this.prisma.user_role.findMany({
      where: { app_user_id: appUserId },
      orderBy: { role_id: 'asc' },
    });
    return rows.map((row) => ({
      userRoleId: Number(row.user_role_id),
      appUserId: Number(row.app_user_id),
      roleId: Number(row.role_id),
    }));
  }

  private async readScopes(appUserId: number): Promise<UserDataScopeView[]> {
    const rows = await this.prisma.user_data_scope.findMany({
      where: { app_user_id: appUserId },
      orderBy: { user_data_scope_id: 'asc' },
    });
    return rows.map((row) => ({
      userDataScopeId: Number(row.user_data_scope_id),
      appUserId: Number(row.app_user_id),
      businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
      plantId: row.plant_id === null ? null : Number(row.plant_id),
    }));
  }

  private async assertUser(appUserId: number): Promise<void> {
    const row = await this.prisma.app_user.findUnique({
      where: { app_user_id: appUserId },
      select: { app_user_id: true },
    });
    if (!row) throw new NotFoundException('없는 사용자입니다.');
  }

  private async assertRolesExist(roleIds: number[]): Promise<void> {
    if (roleIds.length === 0) return;
    const found = await this.prisma.role.findMany({
      where: { role_id: { in: roleIds } },
      select: { role_id: true },
    });
    const known = new Set(found.map((row) => Number(row.role_id)));
    const errors: ErrorItem[] = roleIds.flatMap((roleId, index) =>
      known.has(roleId)
        ? []
        : [
            {
              scope: 'field' as const,
              field: `roleIds[${index}]`,
              code: ERROR_CODE.INVALID,
              message: '없는 역할입니다.',
            },
          ],
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  private async assertScopeTargets(scopes: ScopeInput[]): Promise<void> {
    const businessUnitIds = [...new Set(scopes.map((s) => s.businessUnitId).filter(isId))];
    const plantIds = [...new Set(scopes.map((s) => s.plantId).filter(isId))];
    const [units, plants] = await Promise.all([
      businessUnitIds.length === 0
        ? []
        : this.prisma.business_unit.findMany({
            where: { business_unit_id: { in: businessUnitIds } },
            select: { business_unit_id: true },
          }),
      plantIds.length === 0
        ? []
        : this.prisma.plant.findMany({
            where: { plant_id: { in: plantIds } },
            select: { plant_id: true },
          }),
    ]);
    const knownUnits = new Set(units.map((row) => Number(row.business_unit_id)));
    const knownPlants = new Set(plants.map((row) => Number(row.plant_id)));

    const errors: ErrorItem[] = scopes.flatMap((scope, index) => {
      const items: ErrorItem[] = [];
      if (isId(scope.businessUnitId) && !knownUnits.has(scope.businessUnitId)) {
        items.push(invalid(`scopes[${index}].businessUnitId`, '없는 사업부입니다.'));
      }
      if (isId(scope.plantId) && !knownPlants.has(scope.plantId)) {
        items.push(invalid(`scopes[${index}].plantId`, '없는 공장입니다.'));
      }
      return items;
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

function isId(value: number | null | undefined): value is number {
  return typeof value === 'number';
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

/**
 * 두 제약을 요청 안에서 먼저 본다 — DB 까지 가면 500 이고, 계약은 여기에 400 을 요구한다.
 *
 *   `ck_user_data_scope_target` — 두 축이 다 비면 「어디까지 보는가」가 없다.
 *   `uq_user_data_scope`        — COALESCE(...,0) 으로 빈 축을 접어 유일 판정한다.
 *                                 그래서 「사업부만」 두 줄은 서로 같은 줄이다.
 */
function assertScopeShape(scopes: ScopeInput[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();

  scopes.forEach((scope, index) => {
    if (!isId(scope.businessUnitId) && !isId(scope.plantId)) {
      errors.push({
        scope: 'field',
        field: `scopes[${index}]`,
        code: ERROR_CODE.PAIR,
        message: '사업부와 공장 중 적어도 하나는 지정해야 합니다.',
      });
      return;
    }
    const folded = `${scope.businessUnitId ?? 0} ${scope.plantId ?? 0}`;
    const first = seen.get(folded);
    if (first === undefined) {
      seen.set(folded, index);
      return;
    }
    errors.push({
      scope: 'field',
      field: `scopes[${index}]`,
      code: ERROR_CODE.UNIQUE_VIOLATION,
      uniqueScope: ['businessUnitId', 'plantId'],
      message: `${first + 1}번째와 같은 범위입니다.`,
    });
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
