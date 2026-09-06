import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { LotRegistryModule } from '../core/lot';
import { PrismaModule } from '../prisma/prisma.module';
import { LotController } from './lot/lot.controller';
import { LotService } from './lot/lot.service';

/**
 * 계약 최상위 경로 `/trace` — LOT 과 그 계보·이력.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, LotRegistryModule],
  controllers: [LotController],
  providers: [LotService],
})
export class TraceModule {}
