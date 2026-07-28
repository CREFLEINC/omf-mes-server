import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PERMISSIONS_KEY, PUBLIC_KEY } from './auth.decorators';
import { TERMINAL_AUTH_KEY } from './terminal-auth.decorators';
import { TERMINAL_TOKEN_KIND } from './terminal-auth.service';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  const reflector = { getAllAndOverride: jest.fn() };
  const jwt = { verifyAsync: jest.fn() };
  const auth = { resolvePrincipal: jest.fn() };

  const contextWith = (headers: Record<string, string> = {}) => {
    const request: Record<string, unknown> = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
      __request: request,
    } as unknown as ExecutionContext & { __request: Record<string, unknown> };
  };

  const meta = (opts: { isPublic?: boolean; permissions?: string[] }) => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === PUBLIC_KEY ? opts.isPublic : key === PERMISSIONS_KEY ? opts.permissions : undefined,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AuthGuard(
      reflector as unknown as Reflector,
      jwt as unknown as JwtService,
      auth as unknown as AuthService,
    );
  });

  it('@Public()이면 토큰 없이 통과한다', async () => {
    meta({ isPublic: true });

    await expect(guard.canActivate(contextWith())).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  // 화이트리스트 방식 — 새 엔드포인트에 보호를 깜빡해도 막힌 채로 시작한다.
  it('@Public()이 없으면 토큰을 요구한다', async () => {
    meta({});

    await expect(guard.canActivate(contextWith())).rejects.toThrow(UnauthorizedException);
  });

  it('Bearer가 아닌 인증 헤더는 무시한다', async () => {
    meta({});

    await expect(
      guard.canActivate(contextWith({ authorization: 'Basic dXNlcjpwdw==' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('토큰이 유효하지 않으면 401', async () => {
    meta({});
    jwt.verifyAsync.mockRejectedValue(new Error('bad token'));

    await expect(guard.canActivate(contextWith({ authorization: 'Bearer x' }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('통과하면 주체를 request에 싣는다', async () => {
    meta({});
    jwt.verifyAsync.mockResolvedValue({ sub: '7' });
    const principal = { appUserId: 7n, loginId: 'admin', permissions: [] };
    auth.resolvePrincipal.mockResolvedValue(principal);

    const ctx = contextWith({ authorization: 'Bearer x' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(auth.resolvePrincipal).toHaveBeenCalledWith(7n);
    expect(ctx.__request.user).toBe(principal);
  });

  describe('기능권한', () => {
    beforeEach(() => {
      jwt.verifyAsync.mockResolvedValue({ sub: '7' });
    });

    it('요구 권한을 모두 가지면 통과', async () => {
      meta({ permissions: ['MASTER_READ'] });
      auth.resolvePrincipal.mockResolvedValue({
        appUserId: 7n,
        permissions: ['MASTER_READ', 'MASTER_WRITE'],
      });

      await expect(
        guard.canActivate(contextWith({ authorization: 'Bearer x' })),
      ).resolves.toBe(true);
    });

    it('하나라도 없으면 403', async () => {
      meta({ permissions: ['MASTER_WRITE'] });
      auth.resolvePrincipal.mockResolvedValue({ appUserId: 7n, permissions: ['MASTER_READ'] });

      await expect(
        guard.canActivate(contextWith({ authorization: 'Bearer x' })),
      ).rejects.toThrow(ForbiddenException);
    });

    it('여러 권한을 요구하면 전부 있어야 한다', async () => {
      meta({ permissions: ['MASTER_READ', 'MASTER_WRITE'] });
      auth.resolvePrincipal.mockResolvedValue({ appUserId: 7n, permissions: ['MASTER_READ'] });

      await expect(
        guard.canActivate(contextWith({ authorization: 'Bearer x' })),
      ).rejects.toThrow(/MASTER_WRITE/);
    });
  });

  describe('단말 토큰과의 경계', () => {
    const metaWithTerminal = (opts: { isTerminal?: boolean }) => {
      reflector.getAllAndOverride.mockImplementation((key: string) =>
        key === TERMINAL_AUTH_KEY ? opts.isTerminal : undefined,
      );
    };

    it('@TerminalAuth() 엔드포인트는 TerminalAuthGuard에 맡기고 비켜선다', async () => {
      metaWithTerminal({ isTerminal: true });

      await expect(guard.canActivate(contextWith())).resolves.toBe(true);
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    // 단말 토큰은 1년짜리라, 관리 API까지 통과시키면 사실상 만료 없는 관리자 키가 된다.
    it('단말 토큰으로 관리 API는 통과할 수 없다', async () => {
      metaWithTerminal({});
      jwt.verifyAsync.mockResolvedValue({ sub: '5', kind: TERMINAL_TOKEN_KIND });

      await expect(
        guard.canActivate(contextWith({ authorization: 'Bearer terminal-token' })),
      ).rejects.toThrow('단말 토큰으로는 사용할 수 없는 엔드포인트입니다.');
      expect(auth.resolvePrincipal).not.toHaveBeenCalled();
    });
  });
});
