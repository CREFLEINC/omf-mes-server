export interface NotificationEventView {
  eventCode: string;
  eventName: string;
  description: string;
}

/** 결정 — 통보 099. W-CO-03·11의 읽기 전용 6개 행을 서버 상수로 닫는다. */
export const NOTIFICATION_EVENTS: readonly NotificationEventView[] = [
  {
    eventCode: "EQUIPMENT_BREAKDOWN_OCCURRED",
    eventName: "설비 고장 발생",
    description: "설비 고장 등록이 완료됐을 때",
  },
  {
    eventCode: "MOLD_RECOMMENDED_SHOTS_EXCEEDED",
    eventName: "적정타수 초과",
    description: "공구 사용 저장 뒤 누적 타수가 적정타수를 초과했을 때",
  },
  {
    eventCode: "CALIBRATION_EXPIRY_APPROACHING",
    eventName: "검교정 만료 임박",
    description: "검교정 만료일이 다가왔을 때",
  },
  {
    eventCode: "PURCHASE_ORDER_CHANGE_RECEIVED",
    eventName: "P/O 변경 수신",
    description: "기간계에서 P/O 변경을 수신했을 때",
  },
  {
    eventCode: "INTEGRATION_FAILED",
    eventName: "연계 실패",
    description: "연계 메시지 처리가 실패했을 때",
  },
  {
    eventCode: "APPROVAL_ACTION_REQUIRED",
    eventName: "승인 요청·결재 도착",
    description: "승인 요청 또는 다음 결재 순서가 도착했을 때",
  },
];

export function notificationEvent(
  eventCode: string,
): NotificationEventView | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.eventCode === eventCode);
}
