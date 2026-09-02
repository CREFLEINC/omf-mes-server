import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { ContractException } from '../errors';
import { CONTRACT_OPERATION } from './contract.decorator';
import { ContractValidator } from './contract-validator';

/**
 * `@Contract` 가 붙은 핸들러의 요청을 계약대로 검증한다.
 *
 * 파이프가 아니라 가드다 — 전역 파이프는 `ArgumentMetadata` 만 받아 «어느 핸들러인가»를
 * 알 수 없고, 그것을 모르면 어느 계약 스키마로 볼지 고를 수 없다. 가드는 실행 컨텍스트를
 * 통째로 받으므로 핸들러 메타데이터를 읽을 수 있고, 파이프·인터셉터보다 먼저 돈다.
 *
 * `@Contract` 가 없는 핸들러는 그냥 지나간다 — 헬스체크처럼 계약 밖의 자리가 있다.
 */
@Injectable()
export class ContractValidationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly validator: ContractValidator,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.reflector.get<string | undefined>(
      CONTRACT_OPERATION,
      context.getHandler(),
    );
    if (!key) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // 사본을 검증한다. ajv 의 coerceTypes 가 사본을 그 자리에서 고치므로, 통과한 뒤
    // 되돌려 써야 핸들러가 계약이 선언한 타입을 받는다.
    const query = { ...request.query } as Record<string, unknown>;
    const params = { ...request.params } as Record<string, unknown>;

    const errors = this.validator.validate(key, { body: request.body, query, params });
    if (errors.length > 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    }

    // ⛔ Express 5 의 req.query 는 접근할 때마다 새로 파싱하는 getter 라 제자리 수정이
    // 사라진다. 값으로 덮어써야 남는다 — 안 그러면 계약이 integer 라 선언한 칸을
    // 핸들러가 문자열로 받는다(조용한 타입 거짓말).
    Object.defineProperty(request, 'query', {
      value: query,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    Object.assign(request.params, params);

    return true;
  }
}
