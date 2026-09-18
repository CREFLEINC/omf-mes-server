import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { SESSION_COOKIE } from './session-cookie';
import { SessionResolver, SessionToken, TOKEN_TYPE } from './session-resolver.service';
import { SessionService, issuedBeforePasswordChange } from './session.service';

const jwt = new JwtService({ secret: 'x'.repeat(32) });

const requestWith = (token: string): Request =>
  ({ headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } }) as Request;

const responseSpy = () => {
  const cookie = jest.fn();
  return { response: { cookie } as unknown as Response, cookie };
};

describe('issuedBeforePasswordChange', () => {
  const changedAt = new Date('2026-09-18T03:00:00.400Z'); // 초 = 1789700400

  it('변경보다 앞선 초에 발급된 세션은 끊는다', () => {
    expect(issuedBeforePasswordChange(1789700399, changedAt)).toBe(true);
  });

  it('⭐ 변경과 같은 초에 발급된 세션은 살린다 — iat 는 초라 재발급 쿠키가 거부되면 안 된다', () => {
    expect(issuedBeforePasswordChange(1789700400, changedAt)).toBe(false);
  });

  it('변경 뒤에 발급된 세션은 살린다', () => {
    expect(issuedBeforePasswordChange(1789700401, changedAt)).toBe(false);
  });
});

describe('SessionService.build — 비밀번호 변경 전 발급', () => {
  const changedAt = new Date('2026-09-18T03:00:00.000Z');
  const changedAtSeconds = changedAt.getTime() / 1000;

  const serviceWith = (credential: { password_changed_at: Date } | null) => {
    const prisma = {
      app_user: {
        findFirst: jest.fn().mockResolvedValue({
          app_user_id: 1001n,
          login_id: 'SYN-LOGIN-01',
          user_name: '합성 사용자',
          department_id: null,
          user_credential:
            credential === null ? null : { must_change_password: true, ...credential },
          user_data_scope: [],
          user_role: [],
        }),
      },
    } as unknown as PrismaService;
    return new SessionService(prisma);
  };

  it('변경 전에 발급된 토큰이면 세션이 서지 않는다(→ 401)', async () => {
    const service = serviceWith({ password_changed_at: changedAt });

    await expect(service.build(1001, null, changedAtSeconds - 60)).resolves.toBeNull();
  });

  it('변경 뒤 발급이면 세션이 선다', async () => {
    const service = serviceWith({ password_changed_at: changedAt });

    await expect(service.build(1001, null, changedAtSeconds + 1)).resolves.toMatchObject({
      userId: 1001,
    });
  });

  it('로그인 직후처럼 발급 시각을 넘기지 않으면 견주지 않는다', async () => {
    const service = serviceWith({ password_changed_at: changedAt });

    await expect(service.build(1001, null)).resolves.toMatchObject({ userId: 1001 });
  });

  it('자격이 없는 계정은 견줄 시각이 없어 기존 동작 그대로다', async () => {
    const service = serviceWith(null);

    await expect(service.build(1001, null, 1)).resolves.toMatchObject({ userId: 1001 });
  });
});

describe('SessionResolver', () => {
  const sessionsReturning = () => {
    const build = jest.fn().mockResolvedValue({ userId: 1001 });
    return { sessions: { build } as unknown as SessionService, build };
  };

  it('발급 시각을 세션 조립에 넘긴다', async () => {
    const { sessions, build } = sessionsReturning();
    const resolver = new SessionResolver(jwt, sessions);
    const token = await jwt.signAsync({ sub: 1001, typ: TOKEN_TYPE.SESSION }, { expiresIn: 600 });
    const { iat } = jwt.decode<SessionToken>(token);

    await resolver.resolve(requestWith(token));

    expect(build).toHaveBeenCalledWith(1001, null, iat);
  });

  it('발급 시각이 없는 토큰은 받지 않는다 — 변경 전 발급인지 가를 수 없다', async () => {
    const { sessions, build } = sessionsReturning();
    const resolver = new SessionResolver(jwt, sessions);
    const token = await jwt.signAsync(
      { sub: 1001, typ: TOKEN_TYPE.SESSION },
      { expiresIn: 600, noTimestamp: true },
    );

    await expect(resolver.resolve(requestWith(token))).resolves.toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('재발급은 새 발급 시각을 주고 만료·직전 로그인 시각은 그대로 둔다', async () => {
    const { sessions } = sessionsReturning();
    const resolver = new SessionResolver(jwt, sessions);
    const lla = '2026-09-17T01:00:00.000Z';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const original = await jwt.signAsync(
      { sub: 1001, typ: TOKEN_TYPE.SESSION, lla, iat: nowSeconds - 3600 },
      { expiresIn: 7200 },
    );
    const { exp } = jwt.decode<SessionToken>(original);
    const { response, cookie } = responseSpy();

    await resolver.reissue(requestWith(original), response);

    expect(cookie).toHaveBeenCalledTimes(1);
    const [name, token, options] = cookie.mock.calls[0] as [string, string, { maxAge: number }];
    const next = jwt.decode<SessionToken>(token);
    expect(name).toBe(SESSION_COOKIE);
    expect(next).toMatchObject({ sub: 1001, typ: TOKEN_TYPE.SESSION, lla });
    expect(next.iat).toBeGreaterThanOrEqual(nowSeconds);
    // 만료는 원래 것 — 비밀번호를 바꿨다고 로그인이 연장되지 않는다(서명 사이 1초 오차 허용).
    expect(Math.abs((next.exp ?? 0) - (exp ?? 0))).toBeLessThanOrEqual(1);
    expect(options.maxAge).toBeLessThanOrEqual(3600 * 1000);
  });

  it('세션 쿠키가 아니면 재발급하지 않는다', async () => {
    const { sessions } = sessionsReturning();
    const resolver = new SessionResolver(jwt, sessions);
    const terminal = await jwt.signAsync({ sub: 7, typ: TOKEN_TYPE.TERMINAL }, { expiresIn: 600 });
    const { response, cookie } = responseSpy();

    await resolver.reissue(requestWith(terminal), response);

    expect(cookie).not.toHaveBeenCalled();
  });
});
