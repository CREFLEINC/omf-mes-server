import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { DeliveryQuery, DispatchQuery, NotificationDispatchService } from './notification-dispatch.service';

/** 알림 발송 이력(W-CO-13 · 장부 P-97). */
@Controller('app')
export class NotificationDispatchController {
  constructor(private readonly dispatches: NotificationDispatchService) {}

  @Get('notification-dispatches')
  @Contract('GET /app/notification-dispatches')
  list(@Query() query: DispatchQuery): Promise<PagedResponse<unknown>> {
    return this.dispatches.dispatches(query);
  }

  @Get('zalo-deliveries')
  @Contract('GET /app/zalo-deliveries')
  deliveries(@Query() query: DeliveryQuery): Promise<PagedResponse<unknown>> {
    return this.dispatches.deliveries(query);
  }
}
