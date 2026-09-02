import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { IdempotencyGuard } from './idempotency.guard';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [IdempotencyService, { provide: APP_GUARD, useClass: IdempotencyGuard }],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
