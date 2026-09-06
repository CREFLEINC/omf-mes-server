/**
 * 자재 반출 전표 상태. 계약 `MaterialReturn.statusCode` 가 `x-no-code-key` 라 값 목록이 없고
 * 전이 액션도 0건인데 응답 required 라 값이 있어야 한다 — 서버가 골랐다.
 * 설계 미정 — 문의 053(계약 x-no-code-key · 서버가 잠정 문자열을 골랐다)
 *
 * ⛔ 조회는 이 값을 대조하지 않는다 — 목록 질의는 받은 문자를 그대로 건다(I-10 §5-3).
 */
export const RETURN_REQUESTED = 'REQUESTED';
