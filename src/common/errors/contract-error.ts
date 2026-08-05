import { BadRequestException } from '@nestjs/common';

import type { components } from '../../contracts/mdm';

export type ErrorItem = components['schemas']['ErrorItem'];
export type ErrorResponse = components['schemas']['ErrorResponse'];

/**
 * 계약이 정한 오류 코드. 계약은 열거형으로 못 박지 않고 설명에 나열만 했다
 * (`UNIQUE_VIOLATION · REQUIRED · RANGE · PAIR · PERMISSION_DENIED · STATE_LOCKED 등`).
 * 값을 여기 모아 두어 오타로 새 코드가 생기는 것을 막는다.
 */
export const ErrorCode = {
  REQUIRED: 'REQUIRED',
  RANGE: 'RANGE',
  /** 두 필드가 짝을 이뤄야 하는데 한쪽만 온 경우. 예: 외부창고인데 거래처가 없다 */
  PAIR: 'PAIR',
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 확정·폐기 상태라 수정이 잠긴 것. 재로드해도 풀리지 않아 저장 충돌(409)과 다르다 */
  STATE_LOCKED: 'STATE_LOCKED',
} as const;

/** 한 필드의 문제. 화면이 그 입력칸 아래 인라인으로 붙인다(공유계약 G-1). */
export function fieldError(
  field: string,
  code: string,
  message: string,
  uniqueScope?: string[],
): ErrorItem {
  return { scope: 'field', field, code, message, ...(uniqueScope ? { uniqueScope } : {}) };
}

/** 화면 수준의 문제. 배너로 띄운다(공유계약 G-1). */
export function screenError(code: string, message: string): ErrorItem {
  return { scope: 'screen', code, message };
}

/**
 * 계약 봉투로 나가는 400.
 *
 * 배열인 이유는 한 번에 여러 개를 돌려주기 위해서다 — 필드 셋이 동시에 틀렸는데
 * 하나씩 알려주면 사용자가 세 번 저장을 눌러야 한다.
 */
export class ContractBadRequest extends BadRequestException {
  constructor(errors: ErrorItem[]) {
    super({ errors } satisfies ErrorResponse);
  }
}
