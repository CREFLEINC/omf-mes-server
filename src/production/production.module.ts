import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderReleaseService } from './work-order/work-order-release.service';
import { WorkOrderResourcePlanService } from './work-order/work-order-resource-plan.service';
import { WorkOrderTransitionService } from './work-order/work-order-transition.service';
import { WorkOrderWriteService } from './work-order/work-order-write.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). 발행이 채번을, 중단·재개가 상태기계를 부른다(PR ④).
 * 배포(PR ⑤b)가 LOT 코어를 부르고 자재 출고요청 표에 직접 쓴다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, NumberingModule, DocumentStateModule, LotRegistryModule],
  controllers: [WorkOrderController],
  providers: [
    WorkOrderQueryService,
    WorkOrderWriteService,
    WorkOrderTransitionService,
    WorkOrderReleaseService,
    WorkOrderResourcePlanService,
  ],
})
export class ProductionModule {}
