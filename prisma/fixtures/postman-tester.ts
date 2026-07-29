/**
 * Postman 시나리오 검증용 관리자 계정.
 *
 * 단말 토큰 발급은 ACCESS_WRITE를 요구하는데(설치 담당자의 일), 시드가 만드는 admin 계정의
 * 초기 비밀번호는 **1회만 출력되고 다시 볼 수 없다.** 그 값을 놓치면 컬렉션의 0번 폴더를
 * 돌릴 방법이 없어진다. 검증 전용 계정을 따로 두어 admin 자격증명을 건드리지 않는다.
 *
 * 실행: `npm run fixtures:postman-admin`
 *   비밀번호를 정하려면 `POSTMAN_ADMIN_PASSWORD=... npm run fixtures:postman-admin`
 *
 * 여러 번 돌려도 되며, 그때마다 비밀번호가 새로 설정된다(분실하면 다시 돌리면 된다).
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { PasswordService } from '../../src/auth/password.service';

const LOGIN_ID = 'postman-tester';
const USER_NAME = 'Postman 검증용';

/**
 * SYSTEM_ADMIN을 붙인다. 컬렉션이 실제로 쓰는 건 ACCESS_WRITE 하나뿐이지만, 검증 항목이
 * 늘 때마다 권한이 모자라 403을 만나는 편보다 낫다 — 아래 운영 차단이 실질 방어선이다.
 */
const ROLE_CODE = 'SYSTEM_ADMIN';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 검증용 계정을 운영에 심지 않는다. 알려진 로그인 ID를 가진 관리자 계정이 남으면
  // 그 자체가 침입 경로다.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NODE_ENV=production에서는 검증용 계정을 만들지 않습니다.');
  }

  const password = process.env.POSTMAN_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  const passwordHash = await new PasswordService().hash(password);

  const user = await prisma.app_user.upsert({
    where: { login_id: LOGIN_ID },
    update: { user_name: USER_NAME, status_code: 'ACTIVE', is_active: true },
    create: { login_id: LOGIN_ID, user_name: USER_NAME, status_code: 'ACTIVE' },
  });

  await prisma.user_credential.upsert({
    where: { app_user_id: user.app_user_id },
    // 기계 계정이라 비밀번호 변경 강제를 걸지 않는다 — 사람이 로그인하는 계정이 아니다.
    update: {
      password_hash: passwordHash,
      must_change_password: false,
      failed_attempt_count: 0,
      locked_until: null,
    },
    create: {
      app_user_id: user.app_user_id,
      password_hash: passwordHash,
      must_change_password: false,
    },
  });

  const role = await prisma.role.findUniqueOrThrow({ where: { role_code: ROLE_CODE } });
  await prisma.user_role.upsert({
    where: { app_user_id_role_id: { app_user_id: user.app_user_id, role_id: role.role_id } },
    update: {},
    create: { app_user_id: user.app_user_id, role_id: role.role_id },
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      'Postman 검증용 계정 준비 완료',
      `  loginId   ${LOGIN_ID}`,
      `  password  ${password}`,
      '',
      'test/postman/local.postman_environment.json의 adminPassword에 위 값을 넣으십시오.',
      '(이 파일은 .gitignore 대상이라 커밋되지 않습니다.)',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
