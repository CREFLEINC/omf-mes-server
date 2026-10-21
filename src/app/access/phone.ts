import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';

/** 베트남 휴대폰 10자리 체계의 국가 코드 표준형 — Zalo `phone` 형식이고 DB CHECK 와 같은 식이다. */
const STANDARD_PHONE = /^84[35789][0-9]{8}$/;

/**
 * `0…`·`+84…`·`84…` 를 받아 표준형 `84XXXXXXXXX` 로 바꾼다. 공백·하이픈은 무시한다.
 * 생략(`undefined`)은 그대로 넘겨 「유지」로 읽게 하고, `null` 은 「지운다」다.
 *
 * ⚠ 계약 검증 가드는 형식까지 보지 않는다 — 여기가 유일한 문지기다(`readPassword` 선례).
 * 문자열이 아닌 값도 여기서 막는다. DB CHECK 에 먼저 부딪히면 400 이어야 할 자리가 500 이 된다.
 */
export function readPhone(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw badPhone();

  const digits = value.replace(/[\s-]/g, '');
  const standard = digits.startsWith('+84')
    ? digits.slice(1)
    : digits.startsWith('0')
      ? `84${digits.slice(1)}`
      : digits;
  if (!STANDARD_PHONE.test(standard)) throw badPhone();
  return standard;
}

function badPhone(): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'field',
      field: 'phoneNumber',
      code: ERROR_CODE.INVALID,
      message: '베트남 휴대폰 번호 형식이 아닙니다 (예: 0912 345 678).',
    },
  ]);
}
