import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderResourcePlanService } from './work-order/work-order-resource-plan.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). 쓰기는 4M 계획 배정뿐이라(PR ③) 멱등만 든다. 채번·상태기계·LOT
 * 코어는 발행·배포(PR ④·⑤)가 붙을 때 여기로 들어온다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [WorkOrderController],
  providers: [WorkOrderQueryService, WorkOrderResourcePlanService],
})
export class ProductionModule {}
