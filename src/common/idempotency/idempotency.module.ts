import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from '../../prisma/prisma.module';
import { IdempotencyGuard } from './idempotency.guard';
import { IdempotencyService } from './idempotency.service';

// 자기 의존을 스스로 선언한다 — 밖에서 누가 PrismaModule 을 들여왔는지에 기대면
// 모듈 조합이 바뀔 때 부팅에서 죽는다(실제로 그랬다).
@Module({
  imports: [PrismaModule],
  providers: [IdempotencyService, { provide: APP_GUARD, useClass: IdempotencyGuard }],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
