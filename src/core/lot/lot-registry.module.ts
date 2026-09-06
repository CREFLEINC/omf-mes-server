import { Module } from '@nestjs/common';

import { LotLifecycleService } from './lot-lifecycle.service';
import { LotRegistryService } from './lot-registry.service';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(`ApprovalModule` 과 같은 이유). */
@Module({
  providers: [LotRegistryService, LotLifecycleService],
  exports: [LotRegistryService, LotLifecycleService],
})
export class LotRegistryModule {}
