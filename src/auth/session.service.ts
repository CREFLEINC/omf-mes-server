import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { Session } from './session.types';

/**
 * 세션 토큰이 마지막 비밀번호 변경보다 먼저 발급됐는가 — 그렇다면 그 세션은 끊는다.
 *
 * 관리웹 세션은 서명 쿠키뿐이라 서버에 끊을 표가 없다. 그래서 «언제 발급됐나»(`iat`)를
 * 자격의 `password_changed_at` 과 견준다. 관리자 초기화(`:reset-password`)와 본인 변경
 * (`me:change-password`)이 둘 다 이 시각을 올리므로 두 경로에서 다른 기기의 로그인이 풀린다.
 * 바꾼 요청을 보낸 세션만은 `SessionResolver.reissue` 가 새 쿠키를 줘서 살린다.
 *
 * ⚠ `iat` 는 초 단위다. 변경 시각도 초로 내려 견준다 — 밀리초로 견주면 변경과 같은 초에
 * 새로 받은 쿠키(재발급·재로그인)가 「변경 전 발급」으로 거부된다. 그 대가로 변경과 같은 초에
 * 먼저 발급된 쿠키 하나는 살아남는다(최대 1초 창).
 */
export function issuedBeforePasswordChange(issuedAtSeconds: number, passwordChangedAt: Date): boolean {
  return issuedAtSeconds < Math.floor(passwordChangedAt.getTime() / 1000);
}

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
  async build(
    appUserId: number,
    lastLoginAt: Date | null,
    issuedAtSeconds?: number,
  ): Promise<Session | null> {
    const user = await this.prisma.app_user.findFirst({
      // ⛔ is_active 가 계정 사용 여부를 정한다. status_code 는 «인사» 상태라 판정에 쓰지
      // 않는다 — 휴직인데 계정은 살려 두는 경우가 실재한다(계약 AppUser.statusCode).
      where: { app_user_id: appUserId, is_active: true },
      include: {
        user_credential: { select: { must_change_password: true, password_changed_at: true } },
        user_data_scope: true,
        user_role: { include: { role: { include: { role_permission: true } } } },
      },
    });
    if (!user) return null;
    if (
      issuedAtSeconds !== undefined &&
      user.user_credential &&
      issuedBeforePasswordChange(issuedAtSeconds, user.user_credential.password_changed_at)
    ) {
      return null;
    }

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
      // 자격이 없는 계정은 로그인 자체가 안 된다 — 여기 닿는 길은 관리자가 자격을 지운
      // 뒤 세션만 남은 자리뿐이라 「바꿔야 한다」로 몰지 않는다.
      mustChangePassword: user.user_credential?.must_change_password ?? false,
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
