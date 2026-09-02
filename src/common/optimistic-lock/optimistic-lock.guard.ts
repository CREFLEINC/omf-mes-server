import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { CONTRACT_OPERATION, ContractRegistry } from '../contract';
import { ContractException, ERROR_CODE } from '../errors';
import { IF_MATCH_HEADER, parseIfMatch, rememberIfMatch } from './optimistic-lock';

type Requirement = 'required' | 'optional' | 'none';

/**
 * 계약이 `If-Match` 를 선언한 자리에 그 헤더를 강제하고, 값을 파싱해 둔다.
 *
 * 계약이 두 갈래로 선언했다:
 *   `IfMatchVersion`(필수, 126) — 관리웹 전용 오퍼레이션
 *   `IfMatchVersionOptional`(선택, 29) — **오프라인에서도 쓰는 자리.** 「없으면 낙관적
 *   잠금 검사를 건너뛴다. 큐에 쌓인 요청은 토큰을 싣지 않는다」(공유계약 C-9)
 *
 * 어느 쪽인지는 **계약 레지스트리가 안다** — 우리가 목록을 들지 않는다.
 */
@Injectable()
export class OptimisticLockGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ContractRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.reflector.get<string | undefined>(CONTRACT_OPERATION, context.getHandler());
    if (!key) return true;

    const requirement = this.requirement(key);
    if (requirement === 'none') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const value = request.headers[IF_MATCH_HEADER];
    const header = Array.isArray(value) ? value[0] : value;

    if (!header) {
      if (requirement === 'optional') return true;
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.REQUIRED,
          message: 'If-Match 헤더가 필요합니다. 상세 조회의 ETag 값을 담으세요.',
        },
      ]);
    }

    const version = parseIfMatch(header);
    if (version === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.INVALID,
          message: 'If-Match 는 상세 조회가 내린 ETag 값이어야 합니다.',
        },
      ]);
    }

    rememberIfMatch(request, version);
    return true;
  }

  private requirement(key: string): Requirement {
    const entry = this.registry.get(key);
    if (!entry) return 'none';

    const pathItem = entry.document.paths?.[entry.path] as Record<string, unknown> | undefined;
    const refs = [
      ...((pathItem?.parameters ?? []) as { $ref?: string }[]),
      ...(((entry.operation as { parameters?: unknown[] }).parameters ?? []) as { $ref?: string }[]),
    ].map((parameter) => parameter.$ref ?? '');

    if (refs.some((ref) => ref.endsWith('/IfMatchVersion'))) return 'required';
    if (refs.some((ref) => ref.endsWith('/IfMatchVersionOptional'))) return 'optional';
    return 'none';
  }
}
