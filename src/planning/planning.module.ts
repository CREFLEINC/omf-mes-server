import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { RoutingController } from './routing/routing.controller';
import { RoutingService } from './routing/routing.service';

/**
 * 계약 최상위 경로 `/planning` — Routing·BOM·생산계획.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class PlanningModule {}
