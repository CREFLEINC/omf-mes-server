import { Controller, Get } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { NOTIFICATION_EVENTS } from './notification-events';

@Controller('app/notification-events')
export class NotificationEventController {
  @Get()
  @Contract('GET /app/notification-events')
  events(): { items: typeof NOTIFICATION_EVENTS } {
    return { items: NOTIFICATION_EVENTS };
  }
}
