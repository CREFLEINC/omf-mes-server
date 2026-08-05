import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { JwtConfig } from './jwt.config';
import { PasswordService } from './password.service';

const HASH = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';

function build(overrides: {
  user?: unknown;
  verify?: boolean;
} = {}) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    app_user: { findUnique: jest.fn().mockResolvedValue(overrides.user ?? null) },
    user_credential: { update },
  } as unknown as PrismaService;

  const passwords = {
    hash: jest.fn().mockResolvedValue(HASH),
    verify: jest.fn().mockResolvedValue(overrides.verify ?? false),
  } as unknown as PasswordService;

  const jwt = { signAsync: jest.fn().mockResolvedValue('token') } as unknown as JwtService;

  return {
    service: new AuthService(prisma, passwords, jwt, new JwtConfig('x'.repeat(32), 28800)),
    update,
    passwords,
  };
}

const ACTIVE_USER = {
  app_user_id: 7n,
  login_id: 'admin',
  is_active: true,
  user_credential: { password_hash: HASH, must_change_password: true },
};

describe('AuthService.login', () => {
  const credentials = { loginId: 'admin', password: 'pw' };

  it('성공하면 토큰과 비밀번호 변경 필요 여부를 준다', async () => {
    const { service } = build({ user: ACTIVE_USER, verify: true });

    await expect(service.login(credentials)).resolves.toEqual({
      accessToken: 'token',
      expiresIn: 28800,
      mustChangePassword: true,
    });
  });

  it('성공하면 실패 카운터를 0 으로 되돌리고 마지막 로그인을 기록한다', async () => {
    const { service, update } = build({ user: ACTIVE_USER, verify: true });

    await service.login(credentials);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failed_attempt_count: 0, last_login_at: expect.any(Date) }),
      }),
    );
  });

  it('틀린 비밀번호면 실패 카운터를 올린다', async () => {
    const { service, update } = build({ user: ACTIVE_USER, verify: false });

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failed_attempt_count: { increment: 1 } } }),
    );
  });

  it('5회 실패해도 잠기지 않는다 — 잠금은 결정으로 보류했다(ADR 0002)', async () => {
    const { service } = build({ user: { ...ACTIVE_USER, user_credential: { password_hash: HASH, must_change_password: false } }, verify: false });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    }

    // 6번째도 「잠김」이 아니라 같은 401 이다.
    await expect(service.login(credentials)).rejects.toThrow('로그인할 수 없습니다.');
  });

  it.each([
    ['없는 계정', null],
    ['정지된 계정', { ...ACTIVE_USER, is_active: false }],
    ['자격증명이 없는 계정', { ...ACTIVE_USER, user_credential: null }],
  ])('%s 도 틀린 비밀번호와 같은 응답이다 — 계정 열거를 막는다', async (_label, user) => {
    const { service } = build({ user, verify: false });

    await expect(service.login(credentials)).rejects.toThrow('로그인할 수 없습니다.');
  });

  it('없는 계정에도 해시 검증에 준하는 시간을 쓴다 — 응답 시간으로도 새면 안 된다', async () => {
    const { service, passwords } = build({ user: null });

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwords.verify).toHaveBeenCalled();
  });

  it('미끼 해시를 한 번만 만든다 — 매번 만들면 검증보다 오히려 느려진다', async () => {
    const { service, passwords } = build({ user: null });

    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.login(credentials)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(passwords.hash).toHaveBeenCalledTimes(1);
  });
});
