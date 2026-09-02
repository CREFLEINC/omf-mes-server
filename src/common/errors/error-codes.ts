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
  // 계약이 이름 붙인 값은 아니다(설명이 「등」으로 열어 두었다). 형식 위반 —
  // 타입·enum·format·pattern — 을 하나로 모은다. 화면은 field 와 message 로 읽는다.
  INVALID: 'INVALID',
  PAIR: 'PAIR',
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  STATE_LOCKED: 'STATE_LOCKED',
  // 계약이 이름 붙인 값은 아니다. STATE_LOCKED 와 «반드시» 갈려야 한다 — 이쪽은
  // 재로드하면 풀리는 저장 충돌이고 저쪽은 안 풀린다(공유계약 G-1).
  STALE_VERSION: 'STALE_VERSION',
  // 계약이 이름 붙인 값이다 — 「관리 권한 보유자가 0명이 되는 저장」(W-CO-02 §8-6).
  LAST_ADMIN: 'LAST_ADMIN',
  // 계약이 이름 붙인 값이다 — 「라인이 1건 이상이어야 한다」(Routing Rev 확정).
  LINE_REQUIRED: 'LINE_REQUIRED',
  // 계약이 이름 붙인 값이다 — 「확정 버전이 1건 이상 있어야 한다」(검사기준 승인).
  CONFIRMED_VERSION_REQUIRED: 'CONFIRMED_VERSION_REQUIRED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ROUTE_AMBIGUOUS: 'ROUTE_AMBIGUOUS',
  APPROVER_TYPE_NOT_SUPPORTED: 'APPROVER_TYPE_NOT_SUPPORTED',
} as const;

/** 계약에 없는 응답이라 봉투만 맞춰 내보내는 자리. 근거: 계약에 5xx 정의가 없다. */
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
