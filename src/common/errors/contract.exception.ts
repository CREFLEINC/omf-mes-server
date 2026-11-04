import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorItem } from './error-response';

/**
 * 계약 `ErrorResponse` 를 그대로 실어 보내는 예외.
 * 여러 항목을 한 번에 낼 수 있다 — 계약이 `errors` 를 배열로 정의했고, 화면이
 * 필드 오류를 한꺼번에 표시하기 때문이다.
 */
export class ContractException extends HttpException {
  readonly errors: ErrorItem[];

  /** `extra` 는 계약이 `errors` 옆에 둔 칸 — 예: 출고 예정 충돌의 `plannedStockConflicts`(피처 003). */
  constructor(
    status: HttpStatus,
    errors: ErrorItem[],
    readonly extra?: Record<string, unknown>,
  ) {
    super({ errors, ...extra }, status);
    this.errors = errors;
  }
}
