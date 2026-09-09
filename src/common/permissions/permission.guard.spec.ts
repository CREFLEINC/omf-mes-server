/**
 * 권한 가드의 네 갈래를 단위로 잠근다.
 *
 * ⭐⭐ 왜 «단위»인가 — 2026-09-09 에 `permission-gate.e2e-spec.ts` 가 스스로 던졌다:
 * 「권한 미등록 403 자리가 «메서드를 통틀어» 없다」. 그 e2e 는 계약에서 «미등록 403 자리»를
 * 하나 찾아 탐침을 달아 F-6 던짐을 확인했는데, 전건이 등록되면서 **찾을 자리가 0** 이 됐다.
 * ⇒ 그 축은 e2e 로 더는 만들 수 없다. README §6-3 의 「e2e 로 반증 불가 부류」 그대로,
 *   **어느 층으로 내려갈지의 신호**로 읽고 여기로 옮겼다.
 *
 * ⛔ F-6 — 「판정할 수 없음」을 「통과」로 처리하지 않는다. 등록되지 않은 자리는 통과가
 *    아니라 **던짐**이고, 그 던짐은 `ContractException` 이 아니다(사용자 문구가 아니라
 *    구현이 멈춰야 하는 자리다).
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { attachSession } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { CONTRACT_OPERATION, ContractRegistry } from '../contract';
import { ContractException } from '../errors';
import { OPERATION_PERMISSIONS } from './operation-permissions';
import { PermissionGuard } from './permission.guard';

describe('권한 가드 (단위)', () => {
  /** 계약이 403 을 선언하고 권한이 등록된 실재 키. */
  const GATED = 'GET /app/notification-subscriptions';
  /** 계약이 403 을 선언하지 «않은» 실재 키. */
  const UNGATED = 'GET /app/sessions/current';

  const registry = ContractRegistry.load();

  function guard(): PermissionGuard {
    return new PermissionGuard(new Reflector(), registry);
  }

  function context(key: string | undefined, permissions: readonly string[] | null): ExecutionContext {
    // ⛔ 세션이 붙는 자리를 «짐작하지» 않는다 — 실제 API 로 붙인다(심볼 키라 손으로 못 쓴다).
    const request = {} as Request;
    if (permissions !== null) attachSession(request, { permissions: [...permissions] } as unknown as Session);
    return {
      getHandler: () => {
        const handler = (): void => undefined;
        if (key !== undefined) Reflect.defineMetadata(CONTRACT_OPERATION, key, handler);
        return handler;
      },
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('⭐ 전제 — 고른 두 키가 계약에서 실제로 그 갈래다', () => {
    const responses = (key: string): Record<string, unknown> | undefined =>
      (registry.get(key)?.operation as { responses?: Record<string, unknown> })?.responses;

    expect(responses(GATED)).toHaveProperty('403');
    expect(responses(UNGATED)).not.toHaveProperty('403');
    expect(OPERATION_PERMISSIONS[GATED]).toBeDefined();
  });

  it('계약 표기가 없는 핸들러는 그냥 지나간다', () => {
    expect(guard().canActivate(context(undefined, []))).toBe(true);
  });

  it('⛔ 계약이 403 을 선언하지 «않은» 자리는 권한을 보지 않는다', () => {
    // 「지금 나는 누구인가」 같은 자리가 잠기면 안 된다 — 계약이 그 구분을 이미 했다.
    expect(guard().canActivate(context(UNGATED, []))).toBe(true);
  });

  it('세션이 없으면 여기서 다시 세지 않는다 — 인증 가드가 이미 막았다', () => {
    expect(guard().canActivate(context(GATED, null))).toBe(true);
  });

  it('⭐ 권한을 가지면 지나간다', () => {
    expect(guard().canActivate(context(GATED, OPERATION_PERMISSIONS[GATED]))).toBe(true);
  });

  it('⛔ 권한이 없으면 403 ContractException 이다', () => {
    expect(() => guard().canActivate(context(GATED, ['없는-권한']))).toThrow(ContractException);
  });

  it('⛔⛔ F-6 — 권한이 «등록되지 않은» 자리는 통과가 아니라 던짐이고, ContractException 이 아니다', () => {
    // 계약에는 있으나 `OPERATION_PERMISSIONS` 에 없는 키를 만들 길이 오늘은 없다(전건 등록).
    // 그래서 상수에서 «한 줄을 빼고» 그 자리를 재현한다 — 이 갈래가 살아 있음을 보이는
    // 유일한 방법이다. ⛔ 통과(true)로 바뀌면 「권한을 안 본다」와 같아진다.
    const saved = OPERATION_PERMISSIONS[GATED];
    delete (OPERATION_PERMISSIONS as Record<string, readonly string[] | undefined>)[GATED];
    try {
      expect(() => guard().canActivate(context(GATED, ['아무-권한']))).toThrow(
        /권한이 등록되지 않았다/,
      );
      // 사용자에게 보일 문구가 아니다 — 계약 예외로 접히면 403 으로 나가 버린다.
      expect(() => guard().canActivate(context(GATED, ['아무-권한']))).not.toThrow(
        ContractException,
      );
      expect(() => guard().canActivate(context(GATED, ['아무-권한']))).not.toThrow(
        ForbiddenException,
      );
    } finally {
      (OPERATION_PERMISSIONS as Record<string, readonly string[]>)[GATED] = saved;
    }
    expect(OPERATION_PERMISSIONS[GATED]).toEqual(saved);
  });
});
