import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { AuthPrincipal, AuthService } from './auth.service';
import { PERMISSIONS_KEY, PUBLIC_KEY } from './auth.decorators';

/**
 * `@Public()`이 없는 **모든** 엔드포인트가 토큰을 요구한다 — 화이트리스트라
 * 새 엔드포인트에 보호를 깜빡해도 막힌 채로 시작한다.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('인증 토큰이 없습니다.');
    }

    let appUserId: bigint;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      appUserId = BigInt(payload.sub);
    } catch {
      throw new UnauthorizedException('토큰이 유효하지 않거나 만료되었습니다.');
    }

    const principal = await this.auth.resolvePrincipal(appUserId);
    request.user = principal;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length) {
      const missing = required.filter((p) => !principal.permissions.includes(p));
      if (missing.length > 0) {
        throw new ForbiddenException(`권한이 없습니다: ${missing.join(', ')}`);
      }
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const [scheme, value] = request.headers.authorization?.split(' ') ?? [];
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
