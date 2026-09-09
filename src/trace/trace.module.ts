import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { LotLifecycleEventController } from './lot/lot-lifecycle-event.controller';
import { LotCompleteService } from './lot/lot-complete.service';
import { LotExternalIdentifierService } from './lot/lot-external-identifier.service';
import { LotHoldListService } from './lot/lot-hold-list.service';
import { LotIqcSkipService } from './lot/lot-iqc-skip.service';
import { LotLifecycleEventService } from './lot/lot-lifecycle-event.service';
import { LotStatusEventController } from './lot/lot-status-event.controller';
import { LotStatusEventService } from './lot/lot-status-event.service';
import { LotController } from './lot/lot.controller';
import { LotService } from './lot/lot.service';
import { SerialNumberQueryService } from './serial-number/serial-number-query.service';
import { SerialNumberCreateService } from './serial-number/serial-number-create.service';
import { SerialNumberController } from './serial-number/serial-number.controller';

/**
 * 계약 최상위 경로 `/trace` — LOT 과 그 계보·이력.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, LotRegistryModule, ApprovalModule, NumberingModule, AuthModule],
  controllers: [LotController, LotLifecycleEventController, LotStatusEventController, SerialNumberController],
  providers: [
    LotService,
    LotCompleteService,
    LotExternalIdentifierService,
    LotHoldListService,
    LotIqcSkipService,
    LotLifecycleEventService,
    LotStatusEventService,
    SerialNumberQueryService,
    SerialNumberCreateService,
  ],
})
export class TraceModule {}
