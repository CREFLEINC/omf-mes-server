import { Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { notificationWriteContext } from './notification-write-context';
import { NotificationWriteService } from './notification-write.service';

@Controller('app')
export class NotificationWriteController {
  constructor(
    private readonly notifications: NotificationWriteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('notifications/:notificationId\\:read')
  @Contract('POST /app/notifications/{notificationId}:read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @Req() request: Request,
    @Param('notificationId', ParseIntPipe) notificationId: number,
  ): Promise<void> {
    const context = notificationWriteContext(request, HttpStatus.NO_CONTENT);
    await this.idempotency.run(context, (tx) =>
      this.notifications.readWithin(tx, context.appUserId, notificationId),
    );
  }

  @Post('notifications\\:read-all')
  @Contract('POST /app/notifications:read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@Req() request: Request): Promise<{ readCount: number }> {
    const context = notificationWriteContext(request, HttpStatus.OK);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.notifications.readAllWithin(tx, context.appUserId),
    );
    return outcome.body;
  }
}
