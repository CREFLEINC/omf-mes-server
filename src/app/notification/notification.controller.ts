import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { NotificationListQuery, NotificationQueryService } from './notification-query.service';
import { NotificationView } from './notification-view';

@Controller('app/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationQueryService) {}

  @Get()
  @Contract('GET /app/notifications')
  list(
    @Req() request: Request,
    @Query() query: NotificationListQuery,
  ): Promise<PagedResponse<NotificationView>> {
    return this.notifications.list(actorUserIdOf(request), query);
  }

  @Get('unread-count')
  @Contract('GET /app/notifications/unread-count')
  unreadCount(@Req() request: Request): Promise<{ unreadCount: number }> {
    return this.notifications.unreadCount(actorUserIdOf(request));
  }
}

function actorUserIdOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
