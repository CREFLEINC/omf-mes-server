import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { NOTIFICATION_EVENTS, notificationEvent } from "./notification-events";
import { NotificationRecipientInput } from "./notification-recipient-rules";

export const INITIAL_NOTIFICATION_SUBSCRIPTION_VERSION = 1;

export interface NotificationSubscriptionView {
  eventCode: string;
  recipients: NotificationRecipientInput[];
  zaloEnabled: boolean;
}

export interface NotificationSubscriptionRead {
  items: NotificationSubscriptionView[];
  versionNo?: number;
}

interface SubscriptionRow {
  event_type_code: string;
  zalo_enabled: boolean;
  version_no: number;
  recipient_type_code: string | null;
  business_unit_id: bigint | null;
  role_id: bigint | null;
  app_user_id: bigint | null;
}

@Injectable()
export class NotificationSubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(eventCode?: string): Promise<NotificationSubscriptionRead> {
    const selectedEvent = eventCode === undefined ? undefined : notificationEvent(eventCode);
    if (eventCode !== undefined && selectedEvent === undefined) return { items: [] };
    const selected = selectedEvent === undefined ? NOTIFICATION_EVENTS : [selectedEvent];

    const rows = await this.readRows(eventCode);
    const byEvent = groupRows(rows);
    const items = selected.map((event) =>
      subscriptionView(event.eventCode, byEvent),
    );
    return {
      items,
      ...(eventCode === undefined
        ? {}
        : {
            versionNo:
              byEvent.get(eventCode)?.[0]?.version_no ??
              INITIAL_NOTIFICATION_SUBSCRIPTION_VERSION,
          }),
    };
  }

  /** 헤더·Zalo·수신자 규칙을 한 SQL 문의 동일 스냅샷에서 읽는다. */
  private readRows(eventCode?: string): Promise<SubscriptionRow[]> {
    return this.prisma.$queryRaw<SubscriptionRow[]>(Prisma.sql`
      SELECT s.event_type_code, s.zalo_enabled, s.version_no,
             r.recipient_type_code, r.business_unit_id, r.role_id, r.app_user_id
        FROM app.notification_subscription s
        LEFT JOIN app.notification_subscription_recipient r
          ON r.notification_subscription_id = s.notification_subscription_id
       WHERE s.app_user_id IS NULL
         AND s.channel_code IS NULL
         ${eventCode === undefined ? Prisma.empty : Prisma.sql`AND s.event_type_code = ${eventCode}`}
       ORDER BY s.event_type_code, r.notification_subscription_recipient_id
    `);
  }
}

function groupRows(rows: SubscriptionRow[]): Map<string, SubscriptionRow[]> {
  const grouped = new Map<string, SubscriptionRow[]>();
  for (const row of rows)
    grouped.set(row.event_type_code, [
      ...(grouped.get(row.event_type_code) ?? []),
      row,
    ]);
  return grouped;
}

function subscriptionView(
  eventCode: string,
  grouped: Map<string, SubscriptionRow[]>,
): NotificationSubscriptionView {
  const rows = grouped.get(eventCode) ?? [];
  return {
    eventCode,
    recipients: rows.flatMap(recipientView),
    zaloEnabled: rows[0]?.zalo_enabled ?? false,
  };
}

function recipientView(row: SubscriptionRow): NotificationRecipientInput[] {
  if (
    row.recipient_type_code === "ROLE" &&
    row.business_unit_id !== null &&
    row.role_id !== null
  ) {
    return [
      {
        recipientTypeCode: "ROLE",
        businessUnitId: contractId(row.business_unit_id),
        roleId: contractId(row.role_id),
      },
    ];
  }
  if (row.recipient_type_code === "USER" && row.app_user_id !== null) {
    return [{ recipientTypeCode: "USER", userId: contractId(row.app_user_id) }];
  }
  return [];
}

function contractId(id: bigint): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value))
    throw new Error("수신자 ID를 JSON 숫자로 안전하게 표현할 수 없습니다.");
  return value;
}
