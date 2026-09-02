import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';
import { Session } from './session.types';

/**
 * 이 서버가 서명하는 토큰의 «종류». 한 비밀키로 여러 토큰을 서명하므로 종류를 안 담으면
 * 서로 통한다 — 단말 등록 토큰의 `sub` 는 단말 번호인데, 그것을 세션 쿠키로 들이밀면
 * 같은 번호의 «사용자»로 풀린다. 검증하는 쪽이 반드시 종류를 확인한다.
 */
export const TOKEN_TYPE = { SESSION: 'session', TERMINAL: 'terminal' } as const;

/** 쿠키에 실리는 것. 최소로 둔다 — 나머지는 요청마다 DB 에서 다시 푼다. */
export interface SessionToken {
  sub: number;
  typ: typeof TOKEN_TYPE.SESSION;
  /** 이번 로그인 «직전» 시각. 계약 `Session.lastLoginAt` 이 그 뜻이다. */
  lla?: string;
}

const ATTACHED = Symbol('session');

/** 가드가 실어 둔 세션. 인증 가드를 지난 요청에만 있다. */
export function currentSession(request: Request): Session | undefined {
  return (request as Request & { [ATTACHED]?: Session })[ATTACHED];
}

export function attachSession(request: Request, session: Session): void {
  (request as Request & { [ATTACHED]?: Session })[ATTACHED] = session;
}

@Injectable()
export class SessionResolver {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 쿠키에서 세션을 푼다. 없으면 `null` — 만료·위조·형식 오류를 가리지 않는다.
   * 어느 쪽이든 「로그인이 필요하다」로 같고, 가려 주면 토큰을 흔드는 쪽에 단서가 된다.
   */
  async resolve(request: Request): Promise<Session | null> {
    const token = readSessionCookie(request.headers.cookie);
    if (!token) return null;

    try {
      const payload = await this.jwt.verifyAsync<SessionToken>(token);
      // ⛔ 종류를 확인한다. 없으면 단말 등록 토큰(sub = 단말 번호)이 같은 번호의
      // 사용자 세션으로 풀린다 — 비밀키가 하나라 서명은 유효하다.
      if (payload.typ !== TOKEN_TYPE.SESSION) return null;
      return await this.sessions.build(payload.sub, payload.lla ? new Date(payload.lla) : null);
    } catch {
      return null;
    }
  }
}
