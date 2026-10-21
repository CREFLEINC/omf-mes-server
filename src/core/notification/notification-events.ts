/**
 * `CONFIGURED` — 부서×이벤트 설정의 수신자에게 보낸다.
 * `APPROVER` — 그 차례 결재자 한 명에게 보낸다. 설정에 수신자 목록이 없다(FR-010).
 */
export type NotificationRecipientMode = 'CONFIGURED' | 'APPROVER';

export interface NotificationEventView {
  eventCode: string;
  eventName: string;
  description: string;
  recipientMode: NotificationRecipientMode;
}

/**
 * 결정 — 통보 099 의 6개 행을 피처 001(omf-all-around#160 · 장부 P-91)이 바꿨다. 생산 4종을 더하고
 * 적정타수·검교정·P/O 변경·연계 실패 4종을 뺐다(발생기가 없어 과거 알림 0건). 기존 구독 표의 행은 남는다.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventView[] = [
  {
    eventCode: 'WORK_SESSION_STARTED',
    eventName: '생산 실행',
    description: '작업이 시작됐을 때(재시작 포함)',
    recipientMode: 'CONFIGURED',
  },
  {
    eventCode: 'WORK_SESSION_STOPPED',
    eventName: '생산 중단',
    description: '진행 중인 작업이 중단됐을 때',
    recipientMode: 'CONFIGURED',
  },
  {
    eventCode: 'WORK_SESSION_ENDED',
    eventName: '작업 종료',
    description: '작업이 종료됐을 때',
    recipientMode: 'CONFIGURED',
  },
  {
    eventCode: 'WORK_ORDER_CLOSED',
    eventName: '생산 마감',
    description: 'MES W/O가 마감됐을 때',
    recipientMode: 'CONFIGURED',
  },
  {
    eventCode: 'EQUIPMENT_BREAKDOWN_OCCURRED',
    eventName: '설비 고장 발생',
    description: '설비 고장 보고가 접수됐을 때',
    recipientMode: 'CONFIGURED',
  },
  {
    eventCode: 'APPROVAL_ACTION_REQUIRED',
    eventName: '승인 요청·결재 도착',
    description: '승인 요청 또는 다음 결재 순서가 도착했을 때',
    recipientMode: 'APPROVER',
  },
];

export function notificationEvent(eventCode: string): NotificationEventView | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.eventCode === eventCode);
}
