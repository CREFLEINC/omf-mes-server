/**
 * 공정 인계 전표 상태. 계약 `OperationHandover.statusCode` 가 `x-no-code-key` 라 값 목록이 없고
 * ⌜계약이 인계·인수를 «한 행위»로 접어 전이가 0개다⌝ 인데 응답 required 라 값이 있어야 한다 —
 * 서버가 골랐다(I-25 §0 자리 2 ⓐ · 선례 `material-return.constants.ts`).
 *
 * ⛔ 조회는 이 값을 대조하지 않는다 — 목록 질의는 받은 문자를 그대로 건다(§1-5).
 */
export const HANDED_OVER = 'HANDED_OVER';
