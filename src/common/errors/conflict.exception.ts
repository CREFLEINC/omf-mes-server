import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 계약 `ConflictResponse` — 409 의 봉투는 `ErrorResponse` 가 **아니다.**
 *
 * ⛔ 실측: 409 를 선언한 175 오퍼레이션 중 **173** 이 `ConflictResponse` 계열이고
 * `ErrorResponse` 는 둘뿐이다. 그 둘도 「같은 항목이 이미 있다」라 저장 충돌이 아니다.
 * `{ errors: [...] }` 로 내리면 화면이 `conflictCause` 를 못 찾아 **원인을 못 가른다** —
 * 「다른 사용자가 먼저 수정했습니다」와 「기간계 배치가 덮었습니다」가 같은 모양이 된다.
 *
 * ⚠ 계열이 넷 더 있다(`Production`·`Quality`·`Shipment`·`StockReinstatement`). 그쪽은
 * 저장 충돌의 «원인»이 아니라 거부의 «업무 사유»(`code`)를 함께 담는다 — 그 도메인이
 * 서면 이 예외를 넓히는 것이 아니라 각자의 봉투를 만든다(계약이 이름을 가른 이유다).
 */
export type ConflictCause = 'user' | 'erpSync' | 'workerLease';

export interface ConflictResponse {
  conflictCause: ConflictCause;
  message: string;
}

export class ConflictException extends HttpException {
  readonly conflict: ConflictResponse;

  constructor(conflictCause: ConflictCause, message: string) {
    super({ conflictCause, message }, HttpStatus.CONFLICT);
    this.conflict = { conflictCause, message };
  }
}
