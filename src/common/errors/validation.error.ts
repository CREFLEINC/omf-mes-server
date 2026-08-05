import { ValidationError } from '@nestjs/common';

import { ContractBadRequest, ErrorCode, ErrorItem, fieldError } from './contract-error';

/** 값이 아예 없을 때 붙는 제약들. 나머지는 값이 있으나 형식·범위가 틀린 경우다. */
const MISSING_CONSTRAINTS = new Set(['isDefined', 'isNotEmpty']);

/**
 * `class-validator` 의 결과를 계약 봉투로 바꾼다.
 *
 * Nest 기본 출력은 `{statusCode, message: string[], error}` 라 계약(`{errors:[…]}`)과
 * 모양이 다르다. 화면이 어느 입력칸에 무엇을 띄울지 정하려면 필드명과 코드가 갈라져
 * 있어야 하는데, 기본 출력은 사람이 읽는 문장 배열뿐이다.
 */
export function contractValidationException(errors: ValidationError[]): ContractBadRequest {
  return new ContractBadRequest(errors.flatMap((error) => toItems(error)));
}

function toItems(error: ValidationError, parent = ''): ErrorItem[] {
  const path = parent ? `${parent}.${error.property}` : error.property;

  const own = Object.entries(error.constraints ?? {}).map(([constraint, message]) =>
    fieldError(
      path,
      MISSING_CONSTRAINTS.has(constraint) ? ErrorCode.REQUIRED : ErrorCode.RANGE,
      message,
    ),
  );

  // 중첩 DTO 는 자식으로 내려온다. 경로를 이어 붙여야 화면이 어느 칸인지 안다.
  const nested = (error.children ?? []).flatMap((child) => toItems(child, path));

  return [...own, ...nested];
}
