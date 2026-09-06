/**
 * `WorkSessionEvent.reasonName` 파생에 쓰는 사유 코드 그룹(A-25 대응표). 세션 이벤트 유형별로
 * `reason_code` 가 속한 그룹이 갈린다 — STOP 은 작업 중단 사유, CONTROL_OVERRIDE 는 통제 우회
 * 사유다. START·RESUME·END 는 `reason_code` 를 안 쓴다(계약 미선언).
 *
 * 등록·전이(POST)가 쓰는 상태·이벤트 유형 상수는 PR ②·③·④ 가 각자 더한다 — 조회는
 * 대조하지 않는다(§8 「status_code 로 거르지 않는다」).
 */
export const REASON_GROUP_BY_EVENT_TYPE: Record<string, string> = {
  STOP: 'WORK_SESSION_EVENT_REASON',
  CONTROL_OVERRIDE: 'CONTROL_OVERRIDE_REASON',
};
