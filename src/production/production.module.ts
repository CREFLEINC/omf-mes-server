import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderResourcePlanService } from './work-order/work-order-resource-plan.service';
import { WorkOrderTransitionService } from './work-order/work-order-transition.service';
import { WorkOrderWriteService } from './work-order/work-order-write.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). 발행이 채번을, 중단·재개가 상태기계를 부른다(PR ④).
 * LOT 코어는 배포(PR ⑤)가 붙을 때 여기로 들어온다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, NumberingModule, DocumentStateModule],
  controllers: [WorkOrderController],
  providers: [
    WorkOrderQueryService,
    WorkOrderWriteService,
    WorkOrderTransitionService,
    WorkOrderResourcePlanService,
  ],
})
export class ProductionModule {}
