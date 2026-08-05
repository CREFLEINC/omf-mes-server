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

import { AuthPrincipal, PERMISSIONS_KEY, PUBLIC_KEY } from './auth.decorators';
import { JwtPayload } from './auth.service';
import { PrincipalService } from './principal.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 핸들러가 클래스보다 우선한다 — 컨트롤러 전체를 보호하고 한 엔드포인트만 열 수 있다.
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const principal = await this.authenticate(request);
    request.user = principal;

    this.authorize(context, principal);

    return true;
  }

  private async authenticate(request: Request): Promise<AuthPrincipal> {
    // RFC 7235 는 인증 스킴을 대소문자 무시로 다루라고 정한다. 표준을 따르는 클라이언트나
    // 프록시가 스킴을 정규화하면, 엄격히 비교할 경우 원인을 찾기 어려운 401 이 난다.
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('인증이 필요합니다.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      // 만료·서명 불일치·형식 오류를 구분하지 않는다 — 어느 쪽이든 다시 로그인해야 한다.
      throw new UnauthorizedException('인증이 필요합니다.');
    }

    // 토큰이 유효해도 그사이 계정이 정지됐을 수 있다(ADR 0002).
    const principal = await this.principals.load(BigInt(payload.sub));
    if (!principal) throw new UnauthorizedException('인증이 필요합니다.');

    return principal;
  }

  private authorize(context: ExecutionContext, principal: AuthPrincipal): void {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return;

    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length === 0) return;

    // 계약의 오류 봉투를 쓴다 — 61개 오퍼레이션이 403 을 ErrorResponse 로 정의한다.
    // 어느 권한이 모자란지는 담지 않는다: 화면이 할 수 있는 일이 없고, 권한 이름은
    // 시스템 내부 구조다.
    throw new ForbiddenException({
      errors: [{ scope: 'screen', code: 'PERMISSION_DENIED', message: '권한이 없습니다.' }],
    });
  }
}
