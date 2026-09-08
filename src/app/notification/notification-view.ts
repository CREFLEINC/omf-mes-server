import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

const NOTIFICATION_TARGET_TYPES = [
  'EQUIPMENT',
  'MOLD',
  'INSTRUMENT',
  'PURCHASE_ORDER',
  'INTEGRATION_SYNC',
  'APPROVAL_REQUEST',
  'LOT',
  'WORK_ORDER',
  'NONCONFORMANCE',
] as const;

type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

export interface NotificationView {
  notificationId: number;
  eventCode: string;
  message: string;
  occurredAt: string;
  read: boolean;
  openable: boolean;
  targetTypeCode?: NotificationTargetType;
  targetId?: number;
  screenId?: string | null;
  locationPath?: string | null;
}

export type NotificationRow = Prisma.notificationGetPayload<{
  include: { notification_event: true };
}>;

export function notificationView(row: NotificationRow): NotificationView {
  const event = row.notification_event;
  const targetTypeCode = NOTIFICATION_TARGET_TYPES.find(
    (type) => type === event.aggregate_type_code,
  );
  return omitEmpty({
    notificationId: Number(row.notification_id),
    eventCode: event.event_type_code,
    message: row.message,
    occurredAt: event.occurred_at.toISOString(),
    read: row.read_at !== null,
    // 설계 미정 — 문의 102: 화면·위치 원천이 없고, enum 밖 과거 대상은 짝을 생략한다.
    openable: false,
    targetTypeCode,
    targetId: targetTypeCode === undefined ? undefined : Number(event.aggregate_id),
  });
}
