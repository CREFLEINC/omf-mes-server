import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * 「사용자·역할·권한 관리」 화면 코드. 권한 코드는 화면 코드와 1:1 이다(계약 `Permission`).
 * ⛔ 이 권한을 가진 사람이 0명이 되면 **되돌릴 사람이 없어진다** — 역할을 다시 켜는 것도,
 * 사용자를 다시 켜는 것도 이 권한이 있어야 한다.
 */
export const ADMIN_PERMISSION = 'W-CO-02';

/**
 * 관리자가 최소 한 사람 남아 있는지 본다. 계약이 400 `LAST_ADMIN` 으로 이름 붙인 자리다
 * (사용자 결정 2026-09-01 · `W-CO-02` §8-6). 걸리는 쓰기가 넷이다.
 *
 *   `POST /app/roles/{roleId}:deactivate`      역할을 중지하면 그 역할의 권한이 판정에서 빠진다
 *   `PUT  /app/roles/{roleId}/permissions`     치환으로 관리 권한이 빠질 수 있다
 *   `PUT  /app/users/{appUserId}/roles`        치환으로 관리자 역할이 빠질 수 있다
 *   `POST /app/users/{appUserId}:deactivate`   ⭐ 자기 자신도 막는다
 *
 * ⛔ 판정 기준은 «역할»이 아니라 **그 권한 보유자 수**다(계약). 고객이 새 역할을 만들어
 * 같은 권한을 준 경우를 역할로 세면 못 센다.
 *
 * ⛔ 쓰기를 «하기 전»에 예측하지 않고 **하고 나서** 센다. 넷 다 셈이 서로 다르게 얽혀
 * (역할 중지 · 권한 치환 · 배정 치환 · 계정 중지) 예측식을 넷 만들면 그중 하나는 틀린다.
 * 같은 트랜잭션 안에서 세고 던지면 그 쓰기가 통째로 되돌아간다.
 */
export async function assertAdminRemains(tx: Prisma.TransactionClient): Promise<void> {
  const remaining = await tx.app_user.count({
    // 「쓸 수 있는 계정」이 is_active 다 — status_code 는 인사 상태라 판정에 쓰지 않는다
    // (계약 `AppUser.isActive`). 역할도 중지된 것은 권한 판정에서 빠진다(계약 `:deactivate`).
    where: {
      is_active: true,
      user_role: {
        some: {
          role: {
            is_active: true,
            role_permission: { some: { permission_code: ADMIN_PERMISSION } },
          },
        },
      },
    },
  });
  if (remaining > 0) return;

  throw new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.LAST_ADMIN,
      message: '이 저장은 「사용자·역할·권한 관리」 권한을 가진 사람을 0명으로 만듭니다.',
    },
  ]);
}
