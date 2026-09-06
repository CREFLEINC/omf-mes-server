/**
 * 선발행 슬롯의 `lot.source_type_code`. 도메인 둘(`trace` 조회 · `production` 조회)과
 * `:release` 가 같은 문자열을 봐야 해서 코어가 한자리에서 든다 — 시드
 * `LOT_SOURCE_TYPE` 은 `isSystemOwned` 라 시드가 값의 등록부인데 이 값은 코드가 먼저
 * 쓰기 시작했다(문의 036 · 이 PR 이 시드에 함께 등재한다).
 */
export const WORK_ORDER_LOT_SOURCE = 'WORK_ORDER';
