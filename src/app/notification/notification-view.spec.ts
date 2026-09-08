import { NotificationRow, notificationView } from './notification-view';

const ROW: NotificationRow = {
  notification_id: 31n,
  notification_event_id: 17n,
  recipient_user_id: 9n,
  title: '이 제목으로 메시지를 재조립하지 않는다',
  message: '원문 · Nội dung 그대로',
  read_at: null,
  created_at: new Date('2026-09-07T12:00:00.000Z'),
  notification_event: {
    notification_event_id: 17n,
    event_type_code: 'OPAQUE_EVENT',
    aggregate_type_code: 'EQUIPMENT',
    aggregate_id: 11n,
    occurred_at: new Date('2026-09-06T16:59:59.999Z'),
    payload: {
      screenId: 'W-FAKE',
      locationPath: '추측 위치',
      message: '다른 내용',
    },
    created_at: new Date('2026-09-07T11:00:00.000Z'),
  },
};

describe('notificationView', () => {
  it('필수 여섯 칸은 저장값이고 발생 시각과 메시지를 재조립하지 않는다', () => {
    expect(notificationView(ROW)).toEqual({
      notificationId: 31,
      eventCode: 'OPAQUE_EVENT',
      message: '원문 · Nội dung 그대로',
      occurredAt: '2026-09-06T16:59:59.999Z',
      read: false,
      openable: false,
      targetTypeCode: 'EQUIPMENT',
      targetId: 11,
    });
  });

  it('read는 read_at의 존재로만 정한다', () => {
    expect(notificationView({ ...ROW, read_at: new Date(0) }).read).toBe(true);
  });

  it.each([
    'EQUIPMENT',
    'MOLD',
    'INSTRUMENT',
    'PURCHASE_ORDER',
    'INTEGRATION_SYNC',
    'APPROVAL_REQUEST',
    'LOT',
    'WORK_ORDER',
    'NONCONFORMANCE',
  ])('%s 대상은 이동 불가여도 대상 쌍을 보존하고 화면과 위치는 생략한다', (type) => {
    // 설계 미정 — 문의 102
    const view = notificationView({
      ...ROW,
      notification_event: {
        ...ROW.notification_event,
        aggregate_type_code: type,
      },
    });
    expect(view).toMatchObject({
      targetTypeCode: type,
      targetId: 11,
      openable: false,
    });
    expect(view).not.toHaveProperty('screenId');
    expect(view).not.toHaveProperty('locationPath');
  });

  it.each(['LEGACY_TARGET', 'equipment', ''])(
    'enum 밖 과거 유형 %s는 대상 쌍을 생략한다',
    (type) => {
      // 설계 미정 — 문의 102
      const view = notificationView({
        ...ROW,
        notification_event: {
          ...ROW.notification_event,
          aggregate_type_code: type,
        },
      });
      expect(view).not.toHaveProperty('targetTypeCode');
      expect(view).not.toHaveProperty('targetId');
      expect(Object.keys(view).sort()).toEqual(
        ['notificationId', 'eventCode', 'message', 'occurredAt', 'read', 'openable'].sort(),
      );
    },
  );
});
