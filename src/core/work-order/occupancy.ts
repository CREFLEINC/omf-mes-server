/**
 * 교대·작업자를 더는 붙잡지 않는 W/O 상태 — 취소·마감은 물론, 완료된 일도 그 교대·사람을 비운다.
 * 4M 추천의 교대·작업자 «사용 중» 판정과 4M 점검·추천의 설비 중복 배정(`validation.ts` `rivalWindowsWhere`)이 쓴다(omf-all-around#219).
 */
export const RELEASED_WORK_ORDER_STATUSES = ['CANCELLED', 'CLOSED', 'COMPLETED'];
