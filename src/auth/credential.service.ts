import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { verifyPassword } from './password';

/**
 * 잠금 임계. 계약이 값을 정하지 않았다 — 운영 파라미터라 `app.operation_policy` 로 옮길
 * 자리이나 아직 그 값이 확정되지 않아 상수로 둔다.
 */
export const MAX_FAILED_ATTEMPTS = 5;
/** 잠긴 뒤 자동으로 풀리지 않는다 — 계약: 「잠긴 계정은 스스로 풀 수 없다. 관리자가 푼다」. */
const LOCK_FOREVER_UNTIL = new Date('9999-12-31T00:00:00.000Z');

export type CredentialResult =
  | { outcome: 'ok'; appUserId: number; lastLoginAt: Date | null; mustChangePassword: boolean }
  | { outcome: 'invalid'; remainingAttempts?: number }
  | { outcome: 'locked' };

@Injectable()
export class CredentialService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⛔ 아이디가 틀렸는지 비밀번호가 틀렸는지 가려 주지 않는다 — 계정이 있는지가 새어 나간다
   * (계약 `LoginFailure`). 없는 계정에는 `remainingAttempts` 도 담지 않는다.
   */
  async verify(loginId: string, password: string): Promise<CredentialResult> {
    const user = await this.prisma.app_user.findUnique({
      where: { login_id: loginId },
      include: { user_credential: true },
    });

    // ⛔ 계정이 없어도 해시 검증만큼 시간을 쓴다. 곧바로 돌아가면 응답 시간 차이로
    // 계정 존재가 드러난다 — 계약이 막으려는 바로 그것이다.
    if (!user?.user_credential || !user.is_active) {
      await verifyPassword(password, 'scrypt$32768$8$1$AAAA$AAAA');
      return { outcome: 'invalid' };
    }

    const credential = user.user_credential;
    if (credential.locked_until !== null && credential.locked_until > new Date()) {
      return { outcome: 'locked' };
    }

    if (await verifyPassword(password, credential.password_hash)) {
      const lastLoginAt = credential.last_login_at;
      await this.prisma.user_credential.update({
        where: { app_user_id: user.app_user_id },
        data: { failed_attempt_count: 0, locked_until: null, last_login_at: new Date() },
      });
      return {
        outcome: 'ok',
        appUserId: Number(user.app_user_id),
        lastLoginAt,
        mustChangePassword: credential.must_change_password,
      };
    }

    const failed = credential.failed_attempt_count + 1;
    const locked = failed >= MAX_FAILED_ATTEMPTS;
    await this.prisma.user_credential.update({
      where: { app_user_id: user.app_user_id },
      data: {
        failed_attempt_count: failed,
        ...(locked ? { locked_until: LOCK_FOREVER_UNTIL } : {}),
      },
    });

    if (locked) return { outcome: 'locked' };
    // 남은 횟수는 알린다 — 「잠긴 뒤에야 알리지 않기 위해서다」(계약).
    return { outcome: 'invalid', remainingAttempts: MAX_FAILED_ATTEMPTS - failed };
  }
}
