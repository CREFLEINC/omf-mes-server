import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { CONTRACT_OPERATION, ContractRegistry } from '../contract';
import { ContractException, ERROR_CODE } from '../errors';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 계약이 `Idempotency-Key` 를 선언한 오퍼레이션(쓰기 250건)에 그 헤더를 강제한다.
 *
 * ⛔ 계약 검증 파이프(`#94`)는 **헤더를 보지 않는다** — `$ref` 파라미터를 `in` 만 보고
 * 지나간다. 그래서 이 자리가 비어 있었다. 「전 쓰기 API 필수」를 계약이 못 박았으므로
 * 없으면 받지 않는다.
 *
 * 어느 오퍼레이션이 요구하는지는 **계약 레지스트리가 안다** — 우리가 목록을 따로 들지 않는다.
 */
@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ContractRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.reflector.get<string | undefined>(CONTRACT_OPERATION, context.getHandler());
    if (!key || !this.requiresIdempotency(key)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const value = request.headers[IDEMPOTENCY_HEADER];
    const header = Array.isArray(value) ? value[0] : value;

    if (!header) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.REQUIRED,
          message: 'Idempotency-Key 헤더가 필요합니다.',
        },
      ]);
    }
    if (!UUID.test(header)) {
      // 계약이 format: uuid 로 선언했다. 아무 문자열이나 받으면 클라이언트가 키를
      // 재사용하는 실수를 서버가 못 가른다.
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.INVALID,
          message: 'Idempotency-Key 는 uuid 여야 합니다.',
        },
      ]);
    }
    return true;
  }

  /** 계약의 `$ref` 파라미터를 그대로 읽는다. 오퍼레이션·path-item 양쪽을 본다. */
  private requiresIdempotency(key: string): boolean {
    const entry = this.registry.get(key);
    if (!entry) return false;

    const pathItem = entry.document.paths?.[entry.path] as Record<string, unknown> | undefined;
    const parameters = [
      ...((pathItem?.parameters ?? []) as { $ref?: string }[]),
      ...(((entry.operation as { parameters?: unknown[] }).parameters ?? []) as { $ref?: string }[]),
    ];
    return parameters.some((parameter) => parameter.$ref?.endsWith('/IdempotencyKey'));
  }
}
