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
  // 계약이 이름 붙인 값이다 — 「실패한 메시지만 재처리할 수 있다」(연계 메시지 재처리).
  NOT_RETRYABLE: 'NOT_RETRYABLE',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ROUTE_AMBIGUOUS: 'ROUTE_AMBIGUOUS',
  APPROVER_TYPE_NOT_SUPPORTED: 'APPROVER_TYPE_NOT_SUPPORTED',
  // 계약이 이름을 안 준 자리다 — 「진행 중인 승인 요청이 이미 있으면 400 이다」(4 오퍼레이션에
  // 같은 문장). `APPROVAL_REQUIRED`(승인을 «올려라»)와 «반드시» 갈려야 한다 — 이쪽은
  // 「기다려라」다. 이름의 근거: plan-api.md §5.4.
  APPROVAL_IN_PROGRESS: 'APPROVAL_IN_PROGRESS',
  // 계약이 이름을 안 준 자리다 — `POST /logistics/goods-issues/{goodsIssueId}:post` 「승인이
  // 필요한 전표는 승인이 끝나기 전에는 400 이다」가 자리만 세웠다(grep 실측: `contracts/*.json`
  // 에 이 문자열 0건). `APPROVAL_IN_PROGRESS`(기다려라)와 «반드시» 갈려야 한다 — 이쪽은
  // 승인을 «올려라»다(반려는 진행 중이 아니고 다시 상신해야 한다 — 공유계약 J-6).
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  // 계약이 이 자리(P/O 라인 치환)에 코드를 안 줬으나 같은 뜻의 이름을 다른 자리에서 이미
  // 지었다 — `CD-…-CANCEL-BLOCKED-REASON` 「후속 문서가 있다」. 다형 취소(I-5)가 조회의
  // 사유와 실행 오류에 같은 문자열을 쓴다(plan-api.md §5.4).
  SUCCESSOR_EXISTS: 'SUCCESSOR_EXISTS',
  // 계약이 이 자리(입하 등록의 P/O 귀속)에 코드를 안 줬다 — `ck_po_line_received`
  // (`received_qty <= ordered_qty + tolerance_over_qty`)를 손으로 앞당겨 막는 이름이다.
  // ⛔ `RANGE`(발주를 이미 받은 양보다 «적게» 고친다 — 반대 방향)와 갈린다. I-3.md §1-5.
  QTY_EXCEEDS_ORDERED: 'QTY_EXCEEDS_ORDERED',
  // 계약이 이름을 안 준 자리다(grep 실측: `contracts/*.json` 에 이 문자열 0건) —
  // `contracts/logistics-01자재창고.json:6803` 이 「역처리가 재고 잔액을 음수로 만들면
  // 400 이다」로 자리만 세웠고 `plan-api.md` §5.4(1061행)가 S06 에 배정하며 이름을 지었다.
  // 첫 사용처는 I-4 `:post`(잔액 0행·부족 둘 다) — I-5 의 `posting.reverse()` 가 같은
  // 문자열을 쓴다(plan.md §5 규칙 6).
  NEGATIVE_BALANCE: 'NEGATIVE_BALANCE',
  // 아래 셋은 계약 `contracts/logistics-01자재창고.json` `CD-CANCEL-BLOCKED-REASON` enum 5값
  // 중 `SUCCESSOR_EXISTS`·`STATE_LOCKED` 를 뺀 나머지다 — 다형 취소(I-5)가 조회의 「취소 불가
  // 사유」와 실행 오류에 같은 문자열을 쓴다(plan-api.md §5.4).
  // ⚠ 이 PR 은 이름만 예약한다 — 사용처는 I-5 PR ②·④·⑤ 다.
  //
  // 두 번째 `:cancel` — 대상 문서 상태가 이미 `CANCELLED` 다.
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  // `CANCEL_REQUESTED` 인데 다시 취소를 요청했다. ⛔ 봉투는 **400** 이다 — 409 는 S22
  // `:confirm` 자리뿐이다(plan-api.md §5.4 · plan.md §5 규칙 6 · I-5 R-9).
  CANCEL_IN_PROGRESS: 'CANCEL_IN_PROGRESS',
  // 취소 실행 경로가 있는 것은 입하·입고·출고 3종뿐이고, 나머지 6종이 이 코드로 걸린다.
  TYPE_NOT_CANCELABLE: 'TYPE_NOT_CANCELABLE',
  // 실사 상세 `closeBlockedReasonCode`와 `:close` 실패가 같은 어휘를 쓴다.
  // 완료된 실사 · 미실사 잔여 · 차이 미조정을 화면이 각각 다르게 안내한다(통보 275).
  ALREADY_CLOSED: 'ALREADY_CLOSED',
  COUNT_REMAINING: 'COUNT_REMAINING',
  VARIANCE_UNADJUSTED: 'VARIANCE_UNADJUSTED',
  // 계약이 이름 붙인 값이다 — `ProductionConflictResponse.code` enum 5값 중 하나이고
  // W/O 마감이 열린 세션(`ended_at IS NULL`)을 만났을 때 **409** 로 낸다(I-6.md §5-5).
  // ⚠ 이 PR 은 이름만 예약한다 — 사용처는 I-6 PR ⑥b 다.
  OPEN_SESSION_EXISTS: 'OPEN_SESSION_EXISTS',
  // 아래 둘은 계약이 이름을 안 준 자리다 — W/O `:close` 본문 검증 4규칙 중 잔량 처분 두 줄
  // (⌜미달인데 remainderDispositionCode 가 없다 → 400⌝ · ⌜정상·초과인데 있다 → 400⌝).
  // `REQUIRED`/`INVALID` 로 뭉치면 화면(`W-02-05`)이 「처분을 고르라」와 「처분을 지우라」를
  // 같은 코드로 받아 문구를 못 가른다 — 사유 칸(`reasonCode`)이 같은 화면에 나란히 서서
  // 그 둘은 `REQUIRED`/`INVALID` 를 쓰기 때문이다. I-6.md §1-6.
  REMAINDER_DISPOSITION_REQUIRED: 'REMAINDER_DISPOSITION_REQUIRED',
  REMAINDER_DISPOSITION_NOT_ALLOWED: 'REMAINDER_DISPOSITION_NOT_ALLOWED',
} as const;

/** 계약에 없는 응답이라 봉투만 맞춰 내보내는 자리. 근거: 계약에 5xx 정의가 없다. */
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
