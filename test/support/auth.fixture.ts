import { INestApplication } from '@nestjs/common';

import { PasswordService } from '../../src/auth/password.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const PASSWORD = 'e2e-fixture-password';

/**
 * e2e 용 사용자와 토큰. 가드가 화이트리스트라 `@Public()` 이 아닌 엔드포인트는 전부
 * 토큰을 요구한다 — 마스터 e2e 마다 계정을 만들게 되므로 여기로 뺀다.
 *
 * 권한은 역할을 거쳐야 한다(`app_user → user_role → role_permission`). 시드가 만든
 * 역할을 쓰지 않고 테스트 전용 역할을 만든다 — 시드 역할의 권한 구성이 바뀌면
 * 테스트가 엉뚱한 이유로 깨진다.
 */
export type TestUser = {
  appUserId: bigint;
  loginId: string;
  token: string;
};

export async function createUserWithPermissions(
  app: INestApplication,
  prefix: string,
  permissions: string[],
): Promise<TestUser> {
  const prisma = app.get(PrismaService);
  const loginId = `${prefix}-user`;
  const roleCode = `${prefix}-ROLE`;

  await deleteUserWithPermissions(app, prefix);

  const user = await prisma.app_user.create({
    data: { login_id: loginId, user_name: `${prefix} 사용자`, status_code: 'ACTIVE' },
  });
  await prisma.user_credential.create({
    data: {
      app_user_id: user.app_user_id,
      password_hash: await app.get(PasswordService).hash(PASSWORD),
    },
  });

  const role = await prisma.role.create({
    data: {
      role_code: roleCode,
      role_name: `${prefix} 역할`,
      role_permission: { create: permissions.map((permission_code) => ({ permission_code })) },
    },
  });
  await prisma.user_role.create({
    data: { app_user_id: user.app_user_id, role_id: role.role_id },
  });

  return { appUserId: user.app_user_id, loginId, token: await issueToken(app, loginId) };
}

/** 실제 로그인 경로를 통과시킨다 — 토큰을 손으로 만들면 발급 경로가 검증되지 않는다. */
export async function issueToken(app: INestApplication, loginId: string): Promise<string> {
  const { AuthService } = await import('../../src/auth/auth.service');
  const { accessToken } = await app.get(AuthService).login({ loginId, password: PASSWORD });

  return accessToken;
}

/** FK 순서대로 지운다 — 배정 → 권한 → 역할 → 자격증명 → 사용자. */
export async function deleteUserWithPermissions(
  app: INestApplication,
  prefix: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  const user = await prisma.app_user.findUnique({ where: { login_id: `${prefix}-user` } });
  const role = await prisma.role.findUnique({ where: { role_code: `${prefix}-ROLE` } });

  if (user) {
    await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
  }
  if (role) {
    await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
    await prisma.role.delete({ where: { role_id: role.role_id } });
  }
  if (user) {
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
}
