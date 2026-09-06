import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderResourcePlanService } from './work-order/work-order-resource-plan.service';
import { WorkOrderWriteService } from './work-order/work-order-write.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). 발행이 채번을 부른다(PR ④). 상태기계는 중단·재개(④b)가,
 * LOT 코어는 배포(⑤)가 붙을 때 여기로 들어온다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, NumberingModule],
  controllers: [WorkOrderController],
  providers: [
    WorkOrderQueryService,
    WorkOrderWriteService,
    WorkOrderResourcePlanService,
  ],
})
export class ProductionModule {}
