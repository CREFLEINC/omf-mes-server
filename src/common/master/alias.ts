import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../errors';

const ALIAS_MAX = 200;

/**
 * MES 별칭(`aliasName`) — 서버가 만들었거나 ERP 가 정하는 이름 옆에 현장이 부르는 이름을 둔다(장부 P-145·P-148).
 * 계약 밖 칸이라 검증 가드가 보지 않는다. 빈 글은 별칭 없음이다.
 */
export function aliasOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  const text = typeof value === 'string' ? value.trim() : undefined;
  if (text === undefined || text.length > ALIAS_MAX) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'field', field: 'aliasName', code: ERROR_CODE.INVALID, message: `aliasName 은 ${ALIAS_MAX}자 이하 글이거나 null 이어야 합니다.` },
    ]);
  }
  return text === '' ? null : text;
}
