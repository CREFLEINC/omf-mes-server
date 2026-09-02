import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../errors';

/**
 * 계약이 「공백만 불가」로 적은 칸을 본다 — 실측 7자리(역할 2 · 사용자 2 · 창고 1 ·
 * 코드그룹 1 · Routing 1).
 *
 * ⛔ 계약 검증 가드는 타입·`maxLength` 까지만 본다. 계약이 `pattern` 을 안 적었으므로
 * `" "` 는 그냥 통과하고, 그대로 저장하면 목록에서 «이름이 없는 행»이 된다. 사람이
 * 지운 것인지 서버가 잃은 것인지 화면에서 가릴 수 없다.
 *
 * 여러 칸을 한 번에 낸다 — 계약 `ErrorResponse.errors` 가 배열인 이유가 그것이다.
 * 첫 칸에서 멈추면 화면이 한 번에 하나씩만 고치게 된다.
 */
export function assertNotBlank(fields: readonly (readonly [field: string, value: string])[]): void {
  const errors: ErrorItem[] = fields
    .filter(([, value]) => value.trim() === '')
    .map(([field]) => ({
      scope: 'field' as const,
      field,
      code: ERROR_CODE.REQUIRED,
      message: '공백만으로는 채울 수 없습니다.',
    }));
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}
