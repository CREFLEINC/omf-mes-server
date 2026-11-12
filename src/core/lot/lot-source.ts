/**
 * 선발행 슬롯의 `lot.source_type_code`. 도메인 둘(`trace` 조회 · `production` 조회)과
 * `:release` 가 같은 문자열을 봐야 해서 코어가 한자리에서 든다 — 시드
 * `LOT_SOURCE_TYPE` 은 `isSystemOwned` 라 시드가 값의 등록부인데 이 값은 코드가 먼저
 * 쓰기 시작했다(문의 036 · 이 PR 이 시드에 함께 등재한다).
 */
export const WORK_ORDER_LOT_SOURCE = 'WORK_ORDER';

/**
 * 처분 «선별»이 떼어 낸 불량분 LOT 의 원천 — `source_id` 는 원 LOT 이다(omf-all-around#108 · P-53).
 * 시드 `LOT_SOURCE_TYPE` 에 함께 등재한다(마이그 20261020110000).
 */
export const LOT_SPLIT_SOURCE = 'LOT_SPLIT';

/**
 * 미리 만든 자재 관리 LOT 의 원천 — `source_id` 는 발행 묶음(`trace.material_lot_batch`)이다(피처 005 R-3).
 * PDA 입하가 원천을 입하 줄로 바꾼다 — 그래서 이 원천으로 남은 LOT 은 아직 입하되지 않았거나 폐기된 것이다.
 */
export const MATERIAL_LOT_BATCH_SOURCE = 'MATERIAL_LOT_BATCH';
