/**
 * 자재 투입이 쓰는 잠정 문자열 셋. 계약이 `consumptionTypeCode`·`statusCode` 에
 * `x-no-code-key` 를 달아 코드 그룹을 세우지 않겠다고 적었는데 응답 required 라 값이 있어야
 * 한다 — 그 자리를 서버가 문자열로 고른 것이다(선례 I-7 `RESULT_STATUS='CONFIRMED'`).
 * 설계 미정 — 문의 053(계약 x-no-code-key · 서버가 잠정 문자열을 골랐다)
 *
 * ⛔ 조회는 이 값들을 **대조하지 않는다** — 목록 질의는 받은 문자를 그대로 건다(I-10 §5-1).
 *    쓰는 쪽(`POST`)은 PR ② 몫이다.
 */
export const CONSUMPTION_TYPE_DEFAULT = 'NORMAL';
export const CONSUMPTION_STATUS = 'RECORDED';
export const LOT_NORMAL = 'NORMAL';
