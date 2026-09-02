/**
 * 계약 `ErrorItem.code` 설명이 열거한 값. 그 설명이 「등」으로 끝나므로 **닫힌 집합이 아니다** —
 * 도메인이 새 코드를 쓸 수 있고, 그때 이 표에 더한다.
 *
 * ⛔ `STATE_LOCKED` 계열과 저장 충돌(409)은 다르다 — 앞의 것은 재로드해도 풀리지 않고
 * 뒤의 것은 재로드로 풀린다. 근거: 공유계약 G-1.
 */
export const ERROR_CODE = {
  REQUIRED: 'REQUIRED',
  RANGE: 'RANGE',
  PAIR: 'PAIR',
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  STATE_LOCKED: 'STATE_LOCKED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ROUTE_AMBIGUOUS: 'ROUTE_AMBIGUOUS',
  APPROVER_TYPE_NOT_SUPPORTED: 'APPROVER_TYPE_NOT_SUPPORTED',
} as const;

/** 계약에 없는 응답이라 봉투만 맞춰 내보내는 자리. 근거: 계약에 5xx 정의가 없다. */
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
