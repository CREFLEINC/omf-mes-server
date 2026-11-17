import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';

/**
 * 창고 위치 코드(`mdm.warehouse.location_prefix`) — 위치 코드 앞에 붙는 조각이다(`K7QX-Z01-R001`).
 * 모든 창고를 통틀어 유일하고 등록한 뒤에는 바꾸지 않는다(사용자 결정 2026-11-17 · omf-all-around#292).
 *
 * 무작위 값은 DB 가 칸 기본값(`mdm.new_location_prefix()`)으로 만든다 — 헷갈리는 글자(0/O · 1/I/L)를 뺀
 * 대문자·숫자 4자, 쓰지 않은 값이 나올 때까지 다시 뽑는다. 서버·ERP 동기화·시드 어느 길로 넣어도 같은 규칙이
 * 한 곳에서 돈다. 서버는 사람이 고쳐 보낸 값만 본다.
 */

/** 사람이 고쳐 넣는 형식 — 대문자·숫자 2~6자. `-` 가 없어 위치 코드의 첫 조각이 곧 창고다. */
export const LOCATION_PREFIX_PATTERN = /^[A-Z0-9]{2,6}$/;

/**
 * 형식이 틀리면 400 `locationPrefix` INVALID. HTTP 로 오면 계약의 `pattern` 이 먼저 같은 코드로 막는다 —
 * 이것은 계약 검증을 거치지 않는 호출(서비스 직접 호출)의 그물이다.
 */
export function assertLocationPrefixFormat(prefix: string): void {
  if (LOCATION_PREFIX_PATTERN.test(prefix)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('locationPrefix', ERROR_CODE.INVALID, '창고 위치 코드는 영문 대문자·숫자 2~6자로 넣으세요.'),
  ]);
}

/** 다른 창고가 쓰면 400 `locationPrefix` UNIQUE_VIOLATION. */
export function locationPrefixTaken(): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field', field: 'locationPrefix', code: ERROR_CODE.UNIQUE_VIOLATION, uniqueScope: ['locationPrefix'],
    message: '이미 다른 창고가 쓰는 창고 위치 코드입니다.',
  }]);
}

/**
 * 등록한 뒤에는 바꾸지 않는다 — 바꾸면 그 창고의 위치 코드와 현장에 붙인 라벨이 모두 어긋난다.
 * 빼고 보내거나 같은 값이면 통과한다.
 */
export function assertLocationPrefixKept(current: string, sent: string | undefined): void {
  if (sent === undefined || sent === current) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('locationPrefix', ERROR_CODE.STATE_LOCKED, '창고 위치 코드는 등록한 뒤 바꿀 수 없습니다 — 위치 코드와 붙인 라벨이 어긋납니다.'),
  ]);
}
