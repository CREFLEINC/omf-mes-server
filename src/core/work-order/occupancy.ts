/**
 * 교대·작업자를 더는 붙잡지 않는 W/O 상태 — 취소·마감은 물론, 완료된 일도 그 교대·사람을 비운다.
 * 4M 추천의 교대·작업자 «사용 중» 판정이 쓴다. ⛔ 4M 점검의 설비 중복 배정(`validation.ts`)은 상태를 거르지 않는 기존 결정이라 이 목록을 쓰지 않는다.
 */
export const RELEASED_WORK_ORDER_STATUSES = ['CANCELLED', 'CLOSED', 'COMPLETED'];
