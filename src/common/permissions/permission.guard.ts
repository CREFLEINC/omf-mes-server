import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { CONTRACT_OPERATION, ContractRegistry } from '../contract';
import { ContractException, ERROR_CODE } from '../errors';
import { OPERATION_PERMISSIONS } from './operation-permissions';

/**
 * 계약에 묶인 오퍼레이션에 기능 권한을 요구한다. 계약이 **403 을 253 오퍼레이션**에
 * 선언해 두었고, 그 판정이 여기서 난다.
 *
 * ⛔ **계약이 403 을 선언한 자리에서만 본다.** 선언하지 않은 곳에서 403 을 내면 계약과
 * 어긋난다. 계약 실측: 선언 **253** · 미선언 237.
 *
 * ⛔ 그 253 중 등록되지 않은 오퍼레이션은 **통과가 아니라 던짐**이다(공유계약 F-6 —
 * 「판정할 수 없음」을 「통과」로 처리하지 않는다). 지금 **215/253(85%)** 만 등록됐는데,
 * 나머지를 통과시키면 「권한을 안 본다」와 같아진다.
 *
 * 그 던짐은 `ContractException` 이 아니다 — 사용자에게 보일 문구가 아니라 **구현이 멈춰야
 * 하는 자리**다. 도메인 PR 이 자기 오퍼레이션의 권한을 등록하며 닫는다.
 *
 * 여러 화면이 같은 경로를 쓰면 그중 **하나**만 가지면 된다.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ContractRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.reflector.get<string | undefined>(CONTRACT_OPERATION, context.getHandler());
    if (!key) return true;

    // ⛔ 계약이 403 을 선언한 자리에서만 본다. 선언하지 않은 곳에서 403 을 내면 계약과
    //    어긋난다 — 예를 들어 GET /app/sessions/current 는 200 만 선언한다(「지금 나는
    //    누구인가」라 권한을 물을 자리가 아니다). 계약 실측: 선언 253 · 미선언 237.
    if (!this.declaresForbidden(key)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const session = currentSession(request);
    // 세션이 없으면 인증 가드가 이미 막았거나 익명 자리다 — 여기서 다시 세지 않는다.
    if (!session) return true;

    const required = OPERATION_PERMISSIONS[key];
    if (!required) {
      throw new Error(
        `권한이 등록되지 않았다: ${key} — ` +
          'scripts/permissions/derive-map.py 를 돌려 더하거나, 도출이 안 되는 자리면 ' +
          'operation-permissions.ts 에 근거와 함께 적는다 (공유계약 F-6)',
      );
    }

    if (!required.some((permission) => session.permissions.includes(permission))) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        {
          scope: 'screen',
          code: ERROR_CODE.PERMISSION_DENIED,
          message: '이 기능을 쓸 권한이 없습니다.',
        },
      ]);
    }
    return true;
  }

  private declaresForbidden(key: string): boolean {
    const responses = (this.registry.get(key)?.operation as { responses?: Record<string, unknown> })
      ?.responses;
    return responses !== undefined && '403' in responses;
  }
}
