import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { NumberingModule } from '../core/numbering';
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

/**
 * 계약 최상위 경로 `/planning` — Routing·BOM·생산계획.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, DocumentStateModule, NumberingModule],
  controllers: [RoutingController, BomController, ProductionPlanController, ProductionOrderController],
  providers: [
    RoutingService,
    RoutingOperationService,
    RoutingRevisionService,
    BomService,
    ProductionPlanService,
    ProductionOrderService,
  ],
})
export class PlanningModule {}
