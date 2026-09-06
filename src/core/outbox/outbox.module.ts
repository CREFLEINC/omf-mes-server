import { Module } from '@nestjs/common';

import { OutboxService } from './outbox.service';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(`LotRegistryModule` 과 같은 이유). */
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
