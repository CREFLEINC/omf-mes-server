import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { CONTRACT_OPERATION } from '../common/contract';
import { ContractException, ERROR_CODE } from '../common/errors';
import { SessionResolver, attachSession } from './session-resolver.service';

/**
 * 인증 없이 도는 오퍼레이션. **로그인 하나뿐이다.**
 *
 * ⛔ 로그인을 면제하지 않으면 순환이다 — 권한은 세션에서 나오는데 세션은 로그인이 만든다.
 * 요구서 §3 이 `POST /app/sessions` 를 `W-CO-01`(계정 로그인) 화면에 걸어 두었으나,
 * 그것은 «화면»이 그 경로를 부른다는 뜻이지 권한을 요구한다는 뜻이 아니다.
 */
const ANONYMOUS = new Set(['POST /app/sessions']);

/**
 * 계약에 묶인 오퍼레이션은 세션이 있어야 돈다.
 *
 * ⛔ 계약 검증 가드 «앞»에 선다. 뒤에 서면 인증 안 된 호출자가 401 대신 400 과 함께
 * 계약 스키마의 생김새를 돌려받는다.
 *
 * ⚠ **단말 토큰(POP·모바일)은 아직 없다.** 계약이 `terminalToken` 을 정의만 하고
 * `security` 를 어디에도 걸지 않아 어느 오퍼레이션이 단말용인지 계약만으로는 못 가른다.
 * 그때까지 POP·모바일 전용 오퍼레이션은 계정 세션을 요구한다 — 그 도메인을 만들기 «전»에
 * 단말 인증이 서야 한다.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: SessionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const key = this.reflector.get<string | undefined>(CONTRACT_OPERATION, context.getHandler());
    // 계약에 묶이지 않은 자리(헬스체크 등)는 이 가드의 대상이 아니다.
    if (!key || ANONYMOUS.has(key)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.resolver.resolve(request);
    if (!session) {
      throw new ContractException(HttpStatus.UNAUTHORIZED, [
        {
          scope: 'screen',
          code: ERROR_CODE.PERMISSION_DENIED,
          message: '로그인이 필요합니다.',
        },
      ]);
    }

    attachSession(request, session);
    return true;
  }
}
