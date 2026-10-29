/**
 * 서버가 창고마다 두는 위치의 역할(`mdm.location.system_role_code` · 장부 P-145). 창고를 만들면
 * 마이그레이션 `20261029100000_location_system_role` 의 트리거가 함께 만든다 — 사람이 등록하지 않는다.
 */
/** 적치 대기 — 입고는 됐고 아직 놓지 않은 자리. 모든 창고에 하나. */
export const PUTAWAY_STAGING = 'PUTAWAY_STAGING';
/** 창고 전체 — 모든 창고에 하나(장부 P-152). 구역을 만들지 않은 창고는 이 자리 하나가 재고 자리다. */
export const WAREHOUSE_WHOLE = 'WAREHOUSE_WHOLE';
