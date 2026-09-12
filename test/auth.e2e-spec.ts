/**
 * 실제 PostgreSQL 에 대고 돈다. 자격증명·잠금·세션 조립은 DB 상태가 곧 동작이라
 * 흉내로는 「맞다」를 말할 수 없다 — 시드된 관리자와 같은 자리에서 확인한다.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuthModule } from '../src/auth/auth.module';
import { CredentialService, MAX_FAILED_ATTEMPTS } from '../src/auth/credential.service';
import { hashPassword } from '../src/auth/password';
import { SessionService } from '../src/auth/session.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('인증 (실 DB)', () => {
  let prisma: PrismaService;
  let credentials: CredentialService;
  let sessions: SessionService;
  let userId: bigint;
  const LOGIN_ID = 'e2e-auth-probe';
  /** ⛔ 시드가 «빈 DB» 에는 비활성 역할을 남기지 않는다(폐기 6종은 업그레이드된 DB 에만
   *  있다). 있는 것을 찾아 쓰면 검사가 마이그레이션 이력에 매인다 — 직접 만든다. */
  const RETIRED_ROLE_CODE = 'E2E_RETIRED_PROBE';
  const PASSWORD = '테스트-비밀번호-1234';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // ⛔ ConfigModule 이 .env 를 process.env 로 올린다. 빼면 Prisma 가 DATABASE_URL 을
      // 못 찾아 스위트가 통째로 죽는다 — AppModule 을 쓰는 검사가 안 겪던 자리다.
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }), PrismaModule, AuthModule],
    }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    credentials = moduleRef.get(CredentialService);
    sessions = moduleRef.get(SessionService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '검사용', status_code: 'EMPLOYED' },
    });
    userId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: userId, password_hash: await hashPassword(PASSWORD) },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    const existing = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!existing) return;
    await prisma.user_role.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.user_data_scope.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: existing.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: existing.app_user_id } });

    const probeRole = await prisma.role.findUnique({ where: { role_code: RETIRED_ROLE_CODE } });
    if (probeRole) {
      await prisma.role_permission.deleteMany({ where: { role_id: probeRole.role_id } });
      await prisma.role.delete({ where: { role_id: probeRole.role_id } });
    }
  }

  async function resetAttempts(): Promise<void> {
    await prisma.user_credential.update({
      where: { app_user_id: userId },
      data: { failed_attempt_count: 0, locked_until: null },
    });
  }

  describe('자격증명', () => {
    beforeEach(resetAttempts);

    it('맞으면 통과하고 실패 횟수를 되돌린다', async () => {
      await prisma.user_credential.update({
        where: { app_user_id: userId },
        data: { failed_attempt_count: 3 },
      });

      const result = await credentials.verify(LOGIN_ID, PASSWORD);

      expect(result).toMatchObject({ outcome: 'ok', appUserId: Number(userId) });
      const after = await prisma.user_credential.findUniqueOrThrow({
        where: { app_user_id: userId },
      });
      expect(after.failed_attempt_count).toBe(0);
    });

    it('직전 로그인 시각을 준다 — 계약이 「이번 로그인 «직전»」으로 정의했다', async () => {
      await credentials.verify(LOGIN_ID, PASSWORD);
      const second = await credentials.verify(LOGIN_ID, PASSWORD);

      expect(second.outcome).toBe('ok');
      expect(second.outcome === 'ok' && second.lastLoginAt).toBeInstanceOf(Date);
    });

    it('틀리면 남은 횟수를 알린다 — 잠긴 뒤에야 알리지 않기 위해서다', async () => {
      const result = await credentials.verify(LOGIN_ID, '틀린값');

      expect(result).toEqual({ outcome: 'invalid', remainingAttempts: MAX_FAILED_ATTEMPTS - 1 });
    });

    it('⛔ 없는 계정에는 remainingAttempts 를 담지 않는다 — 계정 존재가 드러난다', async () => {
      expect(await credentials.verify('없는-계정', '아무거나')).toEqual({ outcome: 'invalid' });
    });

    it(`실패가 ${MAX_FAILED_ATTEMPTS}번 쌓이면 잠긴다`, async () => {
      for (let i = 1; i < MAX_FAILED_ATTEMPTS; i += 1) {
        expect((await credentials.verify(LOGIN_ID, '틀린값')).outcome).toBe('invalid');
      }

      expect((await credentials.verify(LOGIN_ID, '틀린값')).outcome).toBe('locked');
    });

    it('⛔ 잠기면 «맞는» 비밀번호로도 열리지 않는다 — 스스로 풀 수 없다', async () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
        await credentials.verify(LOGIN_ID, '틀린값');
      }

      expect((await credentials.verify(LOGIN_ID, PASSWORD)).outcome).toBe('locked');
    });

    it('⛔ is_active 가 꺼진 계정은 들어오지 못한다 — 계정 사용 여부는 이 값이 정한다', async () => {
      await prisma.app_user.update({ where: { app_user_id: userId }, data: { is_active: false } });

      expect(await credentials.verify(LOGIN_ID, PASSWORD)).toEqual({ outcome: 'invalid' });

      await prisma.app_user.update({ where: { app_user_id: userId }, data: { is_active: true } });
    });
  });

  describe('세션 조립', () => {
    it('계약 Session 의 필수 칸을 채운다', async () => {
      const session = await sessions.build(Number(userId), null);

      expect(session).toMatchObject({
        userId: Number(userId),
        loginId: LOGIN_ID,
        userName: '검사용',
        scopes: [],
        roles: [],
        permissions: [],
      });
    });

    let builtSession: unknown;

    it('⭐ 권한은 활성 역할의 합집합이다 — 중지된 역할은 판정에서 빠진다', async () => {
      const active = await prisma.role.findUniqueOrThrow({ where: { role_code: 'ROLE_SYS_ADMIN' } });
      const retired = await prisma.role.upsert({
        where: { role_code: RETIRED_ROLE_CODE },
        update: { is_active: false },
        create: { role_code: RETIRED_ROLE_CODE, role_name: '검사용 폐기 역할', is_active: false },
      });
      // 이 역할에 권한을 하나 붙여 둔다 — 붙은 것이 «없으면» 합집합에서 빠졌는지 알 수 없다.
      await prisma.role_permission.upsert({
        where: {
          role_id_permission_code: { role_id: retired.role_id, permission_code: 'W-01-04' },
        },
        update: {},
        create: { role_id: retired.role_id, permission_code: 'W-01-04' },
      });

      await prisma.user_role.createMany({
        data: [
          { app_user_id: userId, role_id: active.role_id },
          { app_user_id: userId, role_id: retired.role_id },
        ],
        skipDuplicates: true,
      });

      const session = await sessions.build(Number(userId), null);

      expect(session?.roles).toEqual(['ROLE_SYS_ADMIN']);
      expect(session?.permissions).toEqual(['W-CO-01', 'W-CO-02', 'W-CO-10']);
      builtSession = session;
    });

    it('⭐ 조립한 세션이 계약 Session 스키마를 만족한다', () => {
      // 계약 원본에서 스키마를 꺼내 우리가 만든 값을 판정하게 한다. 손으로 옮겨 적으면
      // 계약이 바뀐 순간 조용히 드리프트한다.
      const contract = JSON.parse(
        readFileSync(join(__dirname, '../contracts/app-공통.json'), 'utf8'),
      ) as { components: Record<string, unknown> };
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      ajv.addSchema({ $id: 'contract', components: contract.components });
      const validate: ValidateFunction = ajv.compile({
        $ref: 'contract#/components/schemas/Session',
      });

      expect(validate(builtSession)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      // 헛통과가 아님을 보인다 — 필수 칸이 빠지면 걸러야 한다.
      expect(validate({ userId: 1, loginId: 'x' })).toBe(false);
    });

    it('⭐ 강제 변경 표시를 세션이 그대로 싣는다 — 화면이 비밀번호 변경으로 보낼 근거다', async () => {
      expect((await sessions.build(Number(userId), null))?.mustChangePassword).toBe(false);

      await prisma.user_credential.update({
        where: { app_user_id: userId },
        data: { must_change_password: true },
      });

      expect((await sessions.build(Number(userId), null))?.mustChangePassword).toBe(true);

      await prisma.user_credential.update({
        where: { app_user_id: userId },
        data: { must_change_password: false },
      });
    });

    it('is_active 가 꺼진 사용자는 세션이 서지 않는다', async () => {
      await prisma.app_user.update({ where: { app_user_id: userId }, data: { is_active: false } });

      expect(await sessions.build(Number(userId), null)).toBeNull();

      await prisma.app_user.update({ where: { app_user_id: userId }, data: { is_active: true } });
    });
  });
});
