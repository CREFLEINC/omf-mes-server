import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { NotificationSubscriptionReplaceInput } from './notification-recipient-rules';
import { NotificationPreviewService } from './notification-preview.service';
import { NotificationPreviewView } from './notification-preview-view';
import { notificationWriteContext } from './notification-write-context';

@Controller('app')
export class NotificationPreviewController {
  constructor(
    private readonly notifications: NotificationPreviewService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('notification-subscriptions/recipients\\:preview')
  @Contract('POST /app/notification-subscriptions/recipients:preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @Req() request: Request,
    @Body() input: NotificationSubscriptionReplaceInput,
  ): Promise<NotificationPreviewView> {
    const context = notificationWriteContext(request, HttpStatus.OK);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.notifications.previewWithin(tx, input),
    );
    return outcome.body;
  }
}
