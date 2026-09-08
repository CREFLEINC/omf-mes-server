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
 * 저장 충돌의 «원인»이 아니라 거부의 «업무 사유»(`code`)를 함께 담고 그 `code` 가
 * **required** 다(`ProductionConflictResponse` 실측). 그래도 **같은 예외에 선택 `code` 를
 * 더한다**(I-6 R-8) — 봉투를 따로 만들면 `assertUpdated()` 를 도메인마다 복제하게 되고
 * If-Match 충돌은 어느 계열에서나 같은 사건이다. 두 축은 직교하며 겹치는 지점이
 * `VERSION_CONFLICT` ↔ `conflictCause='user'` 하나뿐인 것도 계약이 적어 두었다.
 */
export type ConflictCause = 'user' | 'erpSync' | 'workerLease';

/** 계열이 요구하는 선택 세 칸. 안 주면 봉투는 오늘과 «글자 그대로» 같다. */
export interface ConflictExtra {
  /** `ProductionConflictResponse.code` 등 — 거부의 업무 사유. */
  code?: string;
  /** `VERSION_CONFLICT` 일 때 서버의 현재 `version_no`(계약이 문자열로 적었다). */
  currentVersion?: string;
  /**
   * `QualityConflictResponse.currentLotStatusCode` — 서버의 «현재» LOT 상태. ⛔ 화면이
   * `message` 자유문에서 파싱하지 않는다고 계약이 못박아 구조화 칸이 있어야 한다.
   */
  currentLotStatusCode?: string;
}

export interface ConflictResponse extends ConflictExtra {
  conflictCause: ConflictCause;
  message: string;
}

export class ConflictException extends HttpException {
  readonly conflict: ConflictResponse;

  constructor(conflictCause: ConflictCause, message: string, extra: ConflictExtra = {}) {
    super({ conflictCause, message, ...extra }, HttpStatus.CONFLICT);
    this.conflict = { conflictCause, message, ...extra };
  }
}
