import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { PrismaModule } from '../prisma/prisma.module';
import { RoutingOperationService } from './routing/routing-operation.service';
import { BomController } from './bom/bom.controller';
import { BomService } from './bom/bom.service';
import { ProductionOrderController } from './production-order/production-order.controller';
import { ProductionOrderService } from './production-order/production-order.service';
import { ProductionPlanController } from './production-plan/production-plan.controller';
import { ProductionPlanService } from './production-plan/production-plan.service';
import { RoutingRevisionService } from './routing/routing-revision.service';
import { RoutingController } from './routing/routing.controller';
import { RoutingService } from './routing/routing.service';

/** 계약 최상위 경로 `/planning` — Routing·BOM·생산계획·P/O. `NumberingModule`·`OutboxModule` 은
 * 쓰기 오퍼레이션이 필요한 PR ②④ 몫이라 이 PR(조회 4건)엔 없다. */
@Module({
  imports: [PrismaModule, IdempotencyModule, DocumentStateModule],
  controllers: [RoutingController, BomController, ProductionPlanController, ProductionOrderController],
  providers: [RoutingService, RoutingOperationService, RoutingRevisionService, BomService, ProductionPlanService, ProductionOrderService],
})
export class PlanningModule {}
