import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuthPrincipal } from './auth.decorators';

@Injectable()
export class PrincipalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 토큰의 주체를 매 요청 DB 에서 다시 확인한다(ADR 0002).
   *
   * 토큰은 발급 뒤 8시간 유효한데 그사이 계정이 정지되거나 권한이 회수될 수 있다.
   * 권한을 토큰에 담지 않은 이유도 이것이다 — 담으면 회수해도 만료까지 살아 있다.
   *
   * 정지된 계정이면 `null` 을 준다. 호출부가 401 로 바꾼다.
   */
  async load(appUserId: bigint): Promise<AuthPrincipal | null> {
    const user = await this.prisma.app_user.findUnique({
      where: { app_user_id: appUserId },
      select: {
        app_user_id: true,
        login_id: true,
        is_active: true,
        user_role: { select: { role: { select: { is_active: true, role_permission: true } } } },
      },
    });

    if (!user || !user.is_active) return null;

    // 사용 중지된 역할의 권한은 세지 않는다 — 역할을 중지시켰는데 권한이 남으면
    // 중지가 아무 일도 하지 않은 것이 된다.
    const permissions = new Set(
      user.user_role
        .filter(({ role }) => role.is_active)
        .flatMap(({ role }) => role.role_permission.map((rp) => rp.permission_code)),
    );

    return { appUserId: user.app_user_id, loginId: user.login_id, permissions };
  }
}
