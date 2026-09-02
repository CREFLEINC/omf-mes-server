import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { readSessionCookie } from './session-cookie';
import { SessionService } from './session.service';
import { Session } from './session.types';

/** 쿠키에 실리는 것. 최소로 둔다 — 나머지는 요청마다 DB 에서 다시 푼다. */
export interface SessionToken {
  sub: number;
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
      return await this.sessions.build(payload.sub, payload.lla ? new Date(payload.lla) : null);
    } catch {
      return null;
    }
  }
}
