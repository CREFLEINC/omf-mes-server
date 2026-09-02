import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';

import { Contract } from '../common/contract';
import { ContractException, ERROR_CODE } from '../common/errors';
import { CredentialService } from './credential.service';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie';
import { SessionService } from './session.service';
import { LoginFailure, Session } from './session.types';

interface LoginRequest {
  loginId: string;
  password: string;
}

/** 쿠키에 실리는 것. 최소로 둔다 — 나머지는 요청마다 DB 에서 다시 푼다. */
interface SessionToken {
  sub: number;
  /** 이번 로그인 «직전» 시각. 계약 `Session.lastLoginAt` 이 그 뜻이다. */
  lla?: string;
}

@Controller('app/sessions')
export class SessionController {
  constructor(
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get maxAgeSeconds(): number {
    return Number(this.config.get('JWT_EXPIRES_IN_SECONDS')) || 28800;
  }

  @Post()
  @Contract('POST /app/sessions')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Session | LoginFailure> {
    const result = await this.credentials.verify(body.loginId, body.password);

    if (result.outcome === 'locked') {
      // 423 — 「실패가 쌓여 잠겼다. 스스로 풀 수 없다」(계약).
      throw new ContractException(HttpStatus.LOCKED, [
        {
          scope: 'screen',
          code: ERROR_CODE.STATE_LOCKED,
          message: '계정이 잠겼습니다. 관리자에게 문의하세요.',
        },
      ]);
    }

    if (result.outcome === 'invalid') {
      // ⛔ 401 은 계약 LoginFailure 형태다 — ErrorResponse 봉투가 아니다.
      // 아이디·비밀번호 중 무엇이 틀렸는지 말하지 않는다.
      const failure: LoginFailure = {
        message: '아이디 또는 비밀번호가 맞지 않습니다',
        ...(result.remainingAttempts === undefined
          ? {}
          : { remainingAttempts: result.remainingAttempts }),
      };
      // ⛔ 예외로 던지지 않는다. 전역 필터가 HttpException 을 ErrorResponse 봉투로 바꾸는데,
      // 계약은 이 401 을 «LoginFailure» 로 정의했다 — 봉투를 씌우면 계약과 어긋난다.
      response.status(HttpStatus.UNAUTHORIZED);
      return failure;
    }

    const session = await this.sessions.build(result.appUserId, result.lastLoginAt);
    if (!session) {
      // 자격증명은 맞았는데 세션이 안 선다 = is_active 가 그 사이 꺼졌다.
      throw new ContractException(HttpStatus.UNAUTHORIZED, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '사용할 수 없는 계정입니다.' },
      ]);
    }

    const payload: SessionToken = {
      sub: result.appUserId,
      ...(result.lastLoginAt === null ? {} : { lla: result.lastLoginAt.toISOString() }),
    };
    setSessionCookie(
      response,
      await this.jwt.signAsync(payload, { expiresIn: this.maxAgeSeconds }),
      this.maxAgeSeconds,
    );

    return session;
  }

  @Get('current')
  @Contract('GET /app/sessions/current')
  async current(@Req() request: Request): Promise<Session> {
    const session = await this.resolve(request);
    if (!session) {
      // ⚠ 계약이 이 경로에 200 만 선언했다 — 미인증 응답을 정하지 않았다.
      // 401 로 낸다(설계팀 확인 대상). 봉투는 ErrorResponse 로 맞춘다.
      throw new ContractException(HttpStatus.UNAUTHORIZED, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '로그인이 필요합니다.' },
      ]);
    }
    return session;
  }

  @Delete('current')
  @Contract('DELETE /app/sessions/current')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) response: Response): void {
    // ⚠ 서버에 세션 표가 없으므로(물리 모델 실측) 쿠키를 지우는 것이 로그아웃이다.
    // 이미 나간 토큰은 만료까지 유효하다 — 즉시 끊어야 하면 단말 토큰의 token_version
    // 같은 세대 번호가 계정 쪽에도 있어야 한다. 지금은 없다.
    clearSessionCookie(response);
  }

  private async resolve(request: Request): Promise<Session | null> {
    const token = readSessionCookie(request.headers.cookie);
    if (!token) return null;

    try {
      const payload = await this.jwt.verifyAsync<SessionToken>(token);
      return this.sessions.build(payload.sub, payload.lla ? new Date(payload.lla) : null);
    } catch {
      // 만료·위조·형식 오류를 가리지 않는다 — 어느 쪽이든 「로그인이 필요하다」로 같다.
      return null;
    }
  }
}
