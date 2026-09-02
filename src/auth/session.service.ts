import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { Session } from './session.types';

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 「지금 나는 누구이고 어디까지 보는가」를 계약 `Session` 으로 모은다.
   *
   * ⛔ 권한은 **활성 역할**의 합집합만 푼다. 계약이 그렇게 정했다 — 「중지된 역할은 권한
   * «판정»에서 제외된다 — 부여 기록은 지우지 않는다」(`:deactivate`). 부여 기록으로만
   * 세면 중지한 역할의 권한이 그대로 살아 있게 된다.
   *
   * 화면은 이 배열로 액션을 활성·비활성한다 — 403 을 받아 보고 아는 것이 아니라
   * «누르기 전에» 판정한다(계약 `Session.permissions`).
   */
  async build(appUserId: number, lastLoginAt: Date | null): Promise<Session | null> {
    const user = await this.prisma.app_user.findFirst({
      // ⛔ is_active 가 계정 사용 여부를 정한다. status_code 는 «인사» 상태라 판정에 쓰지
      // 않는다 — 휴직인데 계정은 살려 두는 경우가 실재한다(계약 AppUser.statusCode).
      where: { app_user_id: appUserId, is_active: true },
      include: {
        user_data_scope: true,
        user_role: { include: { role: { include: { role_permission: true } } } },
      },
    });
    if (!user) return null;

    const activeRoles = user.user_role.map((link) => link.role).filter((role) => role.is_active);

    return {
      userId: Number(user.app_user_id),
      loginId: user.login_id,
      userName: user.user_name,
      ...(user.department_id === null ? {} : { departmentId: Number(user.department_id) }),
      ...(lastLoginAt === null ? {} : { lastLoginAt: lastLoginAt.toISOString() }),
      scopes: user.user_data_scope
        .filter((scope) => scope.business_unit_id !== null)
        .map((scope) => ({
          businessUnitId: Number(scope.business_unit_id),
          ...(scope.plant_id === null ? {} : { plantId: Number(scope.plant_id) }),
        })),
      roles: activeRoles.map((role) => role.role_code).sort(),
      permissions: [
        ...new Set(
          activeRoles.flatMap((role) =>
            role.role_permission.map((grant) => grant.permission_code),
          ),
        ),
      ].sort(),
    };
  }
}
