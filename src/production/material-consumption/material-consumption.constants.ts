/**
 * 자재 투입이 쓰는 잠정 문자열 셋. 계약이 `consumptionTypeCode`·`statusCode` 에
 * `x-no-code-key` 를 달아 코드 그룹을 세우지 않겠다고 적었는데 응답 required 라 값이 있어야
 * 한다 — 그 자리를 서버가 문자열로 고른 것이다(선례 I-7 `RESULT_STATUS='CONFIRMED'`).
 * 설계 미정 — 문의 053(계약 x-no-code-key · 서버가 잠정 문자열을 골랐다)
 *
 * ⛔ 조회는 이 값들을 **대조하지 않는다** — 목록 질의는 받은 문자를 그대로 건다(I-10 §5-1).
 *    등록(`POST`)은 본문에 값이 오면 그대로 저장하고 없을 때만 기본값을 넣는다(§3-6 ⓐ).
 *
 * ⛔ 계보(`trace.lot_relation`)의 `source_event_type_code` 후보는 `'MATERIAL_CONSUMPTION'`
 *    (`app.entity_type_registry` 에 실재 — `seed.ts:1418`)이지만 **상수로 두지 않는다** —
 *    이 슬라이스가 계보 행을 만들지 않아 사용처가 0이다. 계보는 문의 052 뒤 — I-10 §3-9.
 */
export const CONSUMPTION_TYPE_DEFAULT = 'NORMAL';
export const CONSUMPTION_STATUS = 'RECORDED';
export const LOT_NORMAL = 'NORMAL';
