/** 선발행 슬롯의 유형(시드 `LOT_TYPE`) — Routing 의 마지막 공정 W/O 의 LOT. */
export const PRODUCTION_LOT_TYPE = 'PRODUCTION';

/**
 * 공정 반제품 — Routing 의 마지막이 아닌 공정 W/O 의 선발행 슬롯(피처 016 R-1). 다음 공정 W/O 에 자재 투입
 * API 로 투입되고, 제품 입고·출하·LOT 분리는 받지 않는다. 생산 공정은 칸에 복사하지 않고 원천 W/O 에서 읽는다.
 */
export const WIP_LOT_TYPE = 'WIP';

/** W/O 가 만든 LOT 의 유형 — 「현재 생산 LOT」처럼 생산 LOT 이면 다 보는 자리가 쓴다. */
export const PRODUCED_LOT_TYPES = [PRODUCTION_LOT_TYPE, WIP_LOT_TYPE];
