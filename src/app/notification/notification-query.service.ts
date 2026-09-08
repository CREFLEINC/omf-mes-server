import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { notificationTimeBoundary } from './notification-time-boundary';
import { NotificationView, notificationView } from './notification-view';

export interface NotificationListQuery {
  unreadOnly?: boolean | string;
  eventCode?: string;
  occurredFrom: string;
  occurredTo: string;
  page?: number;
  size?: number;
}

@Injectable()
export class NotificationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    actorUserId: number,
    query: NotificationListQuery,
  ): Promise<PagedResponse<NotificationView>> {
    const page = pageRequest(query);
    const where: Prisma.notificationWhereInput = {
      recipient_user_id: actorUserId,
      ...(query.unreadOnly === true || query.unreadOnly === 'true' ? { read_at: null } : {}),
      notification_event: {
        ...(query.eventCode === undefined ? {} : { event_type_code: query.eventCode }),
        occurred_at: {
          gte: notificationTimeBoundary(query.occurredFrom),
          lt: notificationTimeBoundary(query.occurredTo),
        },
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: { notification_event: true },
        orderBy: [{ notification_event: { occurred_at: 'desc' } }, { notification_id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return pagedResponse(rows.map(notificationView), total, page);
  }

  async unreadCount(actorUserId: number): Promise<{ unreadCount: number }> {
    const unreadCount = await this.prisma.notification.count({
      where: { recipient_user_id: actorUserId, read_at: null },
    });
    return { unreadCount };
  }
}
