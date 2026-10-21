import { Module } from '@nestjs/common';

import { NotificationEmitter } from './notification-emitter';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(`OutboxModule` 과 같은 이유). */
@Module({
  providers: [NotificationEmitter],
  exports: [NotificationEmitter],
})
export class NotificationCoreModule {}
