/**
 * W/O 가 태어날 때 채우는 값 셋. 두 도메인(`production` 의 직접 발행 · `planning` 의 계획
 * 확정 전개)이 같은 W/O 를 만들어서 코어가 한자리에 든다 — 값이 갈리면 상태기계의 탄생
 * 상태와 유형 판정이 두 벌이 된다(I-24 R-3 · 선례 `lot-source.ts`).
 */
/** 태어나는 상태. ⛔ 전이표 밖이다 — `from` 이 없는 자리는 표에 담을 수 없다. */
export const WORK_ORDER_INITIAL_STATUS = 'PLANNED';
/** 계약 ⌜보내지 않으면 서버가 NORMAL(양산)로 채운다⌝. */
export const WORK_ORDER_DEFAULT_TYPE = 'NORMAL';
/** 물리 `priority_no` 의 기본값과 같은 값 — `@default` 에 기대지 않고 명시한다. */
export const WORK_ORDER_DEFAULT_PRIORITY = 100;
