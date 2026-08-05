import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AuthGuard } from './auth.guard';
import { AuthPrincipal, PERMISSIONS_KEY, PUBLIC_KEY } from './auth.decorators';
import { PrincipalService } from './principal.service';

const PRINCIPAL: AuthPrincipal = {
  appUserId: 7n,
  loginId: 'admin',
  permissions: new Set(['MASTER_READ']),
};

function context(authorization?: string): ExecutionContext {
  const request: Record<string, unknown> = { headers: authorization ? { authorization } : {} };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function build(options: {
  metadata?: Record<string, unknown>;
  verify?: () => unknown;
  principal?: AuthPrincipal | null;
} = {}) {
  const reflector = {
    getAllAndOverride: (key: string) => options.metadata?.[key],
  } as unknown as Reflector;

  const jwt = {
    verifyAsync: jest.fn(async () => {
      if (options.verify) return options.verify();
      return { sub: '7', loginId: 'admin' };
    }),
  } as unknown as JwtService;

  const principals = {
    load: jest.fn().mockResolvedValue(
      options.principal === undefined ? PRINCIPAL : options.principal,
    ),
  } as unknown as PrincipalService;

  return { guard: new AuthGuard(reflector, jwt, principals), principals };
}

describe('AuthGuard', () => {
  describe('인증', () => {
    it('@Public() 이면 토큰 없이 통과한다', async () => {
      const { guard } = build({ metadata: { [PUBLIC_KEY]: true } });

      await expect(guard.canActivate(context())).resolves.toBe(true);
    });

    it('@Public() 이면 계정을 조회하지도 않는다', async () => {
      const { guard, principals } = build({ metadata: { [PUBLIC_KEY]: true } });

      await guard.canActivate(context());

      expect(principals.load).not.toHaveBeenCalled();
    });

    it.each([
      ['헤더가 없으면', undefined],
      ['Bearer 가 아니면', 'Basic abc'],
      ['토큰이 비어 있으면', 'Bearer '],
      ['스킴만 있으면', 'Bearer'],
    ])('%s 401 이다', async (_label, authorization) => {
      const { guard } = build();

      await expect(guard.canActivate(context(authorization))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it.each([['Bearer'], ['bearer'], ['BEARER'], ['BeArEr']])(
      '스킴 %s 를 모두 받는다 — RFC 7235 는 대소문자를 무시하라고 정한다',
      async (scheme) => {
        const { guard } = build();

        await expect(guard.canActivate(context(`${scheme} some-token`))).resolves.toBe(true);
      },
    );

    it('서명이 맞지 않으면 401 이다', async () => {
      const { guard } = build({
        verify: () => {
          throw new Error('invalid signature');
        },
      });

      await expect(guard.canActivate(context('Bearer x'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('토큰이 유효해도 계정이 사라졌거나 정지됐으면 401 이다', async () => {
      // 토큰은 8시간 유효한데 그사이 계정이 정지될 수 있다(ADR 0002).
      const { guard } = build({ principal: null });

      await expect(guard.canActivate(context('Bearer x'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('통과하면 request.user 에 주체를 심는다', async () => {
      const { guard } = build();
      const ctx = context('Bearer x');

      await guard.canActivate(ctx);

      expect(ctx.switchToHttp().getRequest<{ user: AuthPrincipal }>().user).toBe(PRINCIPAL);
    });
  });

  describe('인가', () => {
    it('요구 권한이 없으면 인증만으로 통과한다', async () => {
      const { guard } = build();

      await expect(guard.canActivate(context('Bearer x'))).resolves.toBe(true);
    });

    it('권한을 가지고 있으면 통과한다', async () => {
      const { guard } = build({ metadata: { [PERMISSIONS_KEY]: ['MASTER_READ'] } });

      await expect(guard.canActivate(context('Bearer x'))).resolves.toBe(true);
    });

    it('권한이 모자라면 403 이고 계약의 오류 봉투를 쓴다', async () => {
      const { guard } = build({ metadata: { [PERMISSIONS_KEY]: ['MASTER_LOGISTICS_WRITE'] } });

      const attempt = guard.canActivate(context('Bearer x'));

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({
        response: {
          errors: [{ scope: 'screen', code: 'PERMISSION_DENIED', message: '권한이 없습니다.' }],
        },
      });
    });

    it('여러 권한을 요구하면 전부 있어야 한다', async () => {
      const { guard } = build({
        metadata: { [PERMISSIONS_KEY]: ['MASTER_READ', 'MASTER_LOGISTICS_WRITE'] },
      });

      await expect(guard.canActivate(context('Bearer x'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('어느 권한이 모자란지 응답에 담지 않는다 — 시스템 내부 구조다', async () => {
      const { guard } = build({ metadata: { [PERMISSIONS_KEY]: ['MASTER_LOGISTICS_WRITE'] } });

      await expect(guard.canActivate(context('Bearer x'))).rejects.toMatchObject({
        response: { errors: [expect.not.objectContaining({ missing: expect.anything() }) as object] },
      });
    });
  });
});
