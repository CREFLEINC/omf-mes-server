import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PUBLIC_KEY } from './auth.decorators';
import { TERMINAL_AUTH_KEY } from './terminal-auth.decorators';
import {
  TerminalAuthService,
  TerminalPrincipal,
  TERMINAL_TOKEN_KIND,
} from './terminal-auth.service';

/**
 * `@TerminalAuth()`가 붙은 엔드포인트만 처리한다. 나머지는 AuthGuard가 맡는다 —
 * 두 가드가 서로의 영역을 건드리지 않아 어느 쪽도 우회로가 되지 않는다.
 */
@Injectable()
export class TerminalAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly terminals: TerminalAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isTerminal = this.reflector.getAllAndOverride<boolean>(TERMINAL_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isTerminal) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { terminal?: TerminalPrincipal }>();

    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('단말 토큰이 없습니다.');
    }

    let terminalId: bigint;
    let tokenVersion: number;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; kind?: string; tv?: number }>(
        token,
      );
      if (payload.kind !== TERMINAL_TOKEN_KIND) {
        // 사람 토큰으로 현장 실적을 올릴 수 있으면 worker_id 귀속이 무의미해진다.
        throw new UnauthorizedException('현장 단말 토큰이 필요합니다. 사용자 토큰은 쓸 수 없습니다.');
      }
      if (typeof payload.tv !== 'number') {
        // 세대를 모르면 폐기 여부를 판정할 수 없다 — 통과시키면 폐기가 뚫린다.
        throw new UnauthorizedException('세대 정보가 없는 토큰입니다. 단말 토큰을 재발급하십시오.');
      }
      terminalId = BigInt(payload.sub);
      tokenVersion = payload.tv;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('단말 토큰이 유효하지 않거나 만료되었습니다.');
    }

    request.terminal = await this.terminals.resolvePrincipal(terminalId, tokenVersion);
    return true;
  }
}
