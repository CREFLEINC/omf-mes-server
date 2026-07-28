import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { PUBLIC_KEY } from './auth.decorators';
import { TERMINAL_AUTH_KEY } from './terminal-auth.decorators';
import { TerminalAuthGuard } from './terminal-auth.guard';
import { TerminalAuthService, TERMINAL_TOKEN_KIND } from './terminal-auth.service';

describe('TerminalAuthGuard', () => {
  let guard: TerminalAuthGuard;
  const reflector = { getAllAndOverride: jest.fn() };
  const jwt = { verifyAsync: jest.fn() };
  const terminals = { resolvePrincipal: jest.fn() };

  const contextWith = (headers: Record<string, string> = {}) => {
    const request: Record<string, unknown> = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
      __request: request,
    } as unknown as ExecutionContext & { __request: Record<string, unknown> };
  };

  const meta = (opts: { isPublic?: boolean; isTerminal?: boolean }) => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === PUBLIC_KEY ? opts.isPublic : key === TERMINAL_AUTH_KEY ? opts.isTerminal : undefined,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new TerminalAuthGuard(
      reflector as unknown as Reflector,
      jwt as unknown as JwtService,
      terminals as unknown as TerminalAuthService,
    );
  });

  // 이 가드는 @TerminalAuth()가 붙은 것만 맡는다 — 나머지는 AuthGuard 몫이다.
  it('@TerminalAuth()가 없으면 관여하지 않는다', async () => {
    meta({});

    await expect(guard.canActivate(contextWith())).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('@TerminalAuth()면 단말 토큰을 요구한다', async () => {
    meta({ isTerminal: true });

    await expect(guard.canActivate(contextWith())).rejects.toThrow(UnauthorizedException);
  });

  // 관리자 토큰으로 현장 실적을 올릴 수 있으면 worker_id 귀속이 무의미해진다.
  it('사람 토큰은 거부한다', async () => {
    meta({ isTerminal: true });
    jwt.verifyAsync.mockResolvedValue({ sub: '1', loginId: 'admin' });

    await expect(
      guard.canActivate(contextWith({ authorization: 'Bearer user-token' })),
    ).rejects.toThrow('현장 단말 토큰이 필요합니다. 사용자 토큰은 쓸 수 없습니다.');
    expect(terminals.resolvePrincipal).not.toHaveBeenCalled();
  });

  it('단말 토큰이면 principal을 request에 싣는다', async () => {
    meta({ isTerminal: true });
    jwt.verifyAsync.mockResolvedValue({ sub: '5', kind: TERMINAL_TOKEN_KIND });
    terminals.resolvePrincipal.mockResolvedValue({ terminalId: 5n, terminalCode: 'POP_INJ_01' });

    const context = contextWith({ authorization: 'Bearer terminal-token' });
    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(terminals.resolvePrincipal).toHaveBeenCalledWith(5n);
    expect(context.__request.terminal).toMatchObject({ terminalCode: 'POP_INJ_01' });
  });

  it('만료·위조 토큰은 401', async () => {
    meta({ isTerminal: true });
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      guard.canActivate(contextWith({ authorization: 'Bearer bad' })),
    ).rejects.toThrow('단말 토큰이 유효하지 않거나 만료되었습니다.');
  });

  // 폐기된 단말은 resolvePrincipal에서 걸린다 — 캐시가 없어 다음 요청에서 바로 막힌다.
  it('폐기된 단말이면 서비스가 던진 401이 그대로 나간다', async () => {
    meta({ isTerminal: true });
    jwt.verifyAsync.mockResolvedValue({ sub: '5', kind: TERMINAL_TOKEN_KIND });
    terminals.resolvePrincipal.mockRejectedValue(new UnauthorizedException('사용 중지된 단말입니다.'));

    await expect(
      guard.canActivate(contextWith({ authorization: 'Bearer terminal-token' })),
    ).rejects.toThrow('사용 중지된 단말입니다.');
  });
});
