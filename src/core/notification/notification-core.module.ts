import { Module } from '@nestjs/common';

import { ApprovalNotifier } from './approval-notice';
import { NotificationEmitter } from './notification-emitter';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(`OutboxModule` 과 같은 이유). */
@Module({
  providers: [NotificationEmitter, ApprovalNotifier],
  exports: [NotificationEmitter, ApprovalNotifier],
})
export class NotificationCoreModule {}
