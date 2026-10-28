import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';

/**
 * 단말 작업 수(omf-all-around#190 · 장부 P-137). 질의가 없다 — 범위는 단말 토큰(공장·창고·설비·공정)이 정한다.
 */
export const TERMINAL_WORK_OPERATIONS: Readonly<Record<string, readonly ('POP' | 'MOBILE')[]>> = {
  'GET /app/terminal-work-counts': ['POP', 'MOBILE'],
};

export function assertTerminalWorkScope(request: Request, key: string): void {
  if (!(key in TERMINAL_WORK_OPERATIONS)) throw denied();
  // 남의 공장·창고를 묻는 칸이 없다 — 무엇이든 실어 오면 막는다.
  if (Object.keys(request.query as Record<string, unknown>).length > 0) throw denied();
}

function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' },
  ]);
}
