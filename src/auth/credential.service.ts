import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';

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

  /**
   * 내 비밀번호를 바꾼다.
   *
   * ⛔ **현재 비밀번호를 틀려도 계정을 잠그지 않는다.** 로그인과 달리 이미 인증된 본인이라
   * 실패 횟수를 세지 않는다(계약 · `W-CO-10` §5-2). 로그인 경로의 잠금 논리를 여기로
   * 가져오면 본인이 오타 다섯 번에 자기 계정을 잠근다.
   *
   * ⛔ 바꾼 뒤 다시 로그인시키지 않는다 — 작업 중일 수 있다(계약 §5-3). 세션은 그대로다.
   *
   * ⚠ 새 비밀번호의 «길이»만 계약이 정했다(최소 8). 조합 규칙은 두지 않는다 — 계약이
   * 그렇게 적었고, 계약 검증 가드가 길이를 이미 막는다.
   */
  async changePassword(appUserId: number, currentPassword: string, newPassword: string): Promise<void> {
    const credential = await this.prisma.user_credential.findUnique({
      where: { app_user_id: appUserId },
    });
    // 세션이 있는데 자격이 없다 — 관리자가 지운 뒤 세션이 남은 자리다.
    if (!credential) throw wrongPassword();
    if (!(await verifyPassword(currentPassword, credential.password_hash))) throw wrongPassword();

    await this.prisma.user_credential.update({
      where: { app_user_id: appUserId },
      data: {
        password_hash: await hashPassword(newPassword),
        password_changed_at: new Date(),
        // 임시 비밀번호로 들어온 사람이 여기를 지나면 강제 변경이 풀린다.
        must_change_password: false,
        // 본인이 바꿨으니 로그인 실패 누적은 뜻이 없어진다.
        failed_attempt_count: 0,
        version_no: { increment: 1 },
      },
    });
  }
}

/**
 * 계약이 **401** 로 선언한 자리다 — 「현재 비밀번호가 맞지 않는다」. 400(검증 실패)과 갈린다.
 * ⛔ 남은 시도 횟수를 담지 않는다 — 세지 않으므로 알릴 것이 없다.
 */
function wrongPassword(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    {
      scope: 'field',
      field: 'currentPassword',
      code: ERROR_CODE.INVALID,
      message: '현재 비밀번호가 맞지 않습니다.',
    },
  ]);
}
