import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { PutawayRuleController } from './putaway/putaway-rule.controller';
import { PutawayRuleService } from './putaway/putaway-rule.service';

/**
 * 계약 최상위 경로 `/logistics` — 입하·출고·적치·이동·출하 요청.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [PutawayRuleController],
  providers: [PutawayRuleService],
})
export class LogisticsModule {}
