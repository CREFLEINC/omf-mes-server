import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { IqcHandoverNotifier, LotRegistryModule } from '../core/lot';
import { NotificationCoreModule } from '../core/notification';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { LotFlowChainService } from './flow/lot-flow-chain.service';
import { LotFlowController } from './flow/lot-flow.controller';
import { MaterialLotFlowListService } from './flow/material-lot-flow-list.service';
import { ProductLotFlowListService } from './flow/product-lot-flow-list.service';
import { LotLifecycleEventController } from './lot/lot-lifecycle-event.controller';
import { LotCompleteService } from './lot/lot-complete.service';
import { LotExternalIdentifierService } from './lot/lot-external-identifier.service';
import { LotHoldListService } from './lot/lot-hold-list.service';
import { LotIqcSkipExecuteService } from './lot/lot-iqc-skip-execute.service';
import { LotIqcSkipService } from './lot/lot-iqc-skip.service';
import { LotLifecycleEventService } from './lot/lot-lifecycle-event.service';
import { LotStatusEventController } from './lot/lot-status-event.controller';
import { LotStatusEventService } from './lot/lot-status-event.service';
import { LotController } from './lot/lot.controller';
import { LotService } from './lot/lot.service';
import { LotGenealogyQueryService } from './lot/lot-genealogy-query.service';
import { LotImpactService } from './lot/lot-impact.service';
import { SerialNumberQueryService } from './serial-number/serial-number-query.service';
import { SerialNumberCreateService } from './serial-number/serial-number-create.service';
import { SerialNumberController } from './serial-number/serial-number.controller';

/**
 * 계약 최상위 경로 `/trace` — LOT 과 그 계보·이력.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, LotRegistryModule, ApprovalModule, NumberingModule, AuthModule, NotificationCoreModule],
  controllers: [LotController, LotLifecycleEventController, LotStatusEventController, SerialNumberController, LotFlowController],
  providers: [
    IqcHandoverNotifier,
    LotService,
    LotImpactService,
    LotGenealogyQueryService,
    LotCompleteService,
    LotExternalIdentifierService,
    LotHoldListService,
    LotIqcSkipService,
    LotIqcSkipExecuteService,
    LotLifecycleEventService,
    LotStatusEventService,
    SerialNumberQueryService,
    SerialNumberCreateService,
    MaterialLotFlowListService,
    ProductLotFlowListService,
    LotFlowChainService,
  ],
})
export class TraceModule {}
