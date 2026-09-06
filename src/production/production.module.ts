import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { OutboxModule } from '../core/outbox';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductionResultApprovalService } from './production-result/production-result-approval.service';
import { ProductionResultCorrectService } from './production-result/production-result-correct.service';
import { ProductionResultQueryService } from './production-result/production-result-query.service';
import { ProductionResultService } from './production-result/production-result.service';
import { ProductionResultController } from './production-result/production-result.controller';
import { WorkOrderCancelService } from './work-order/work-order-cancel.service';
import { WorkOrderCloseService } from './work-order/work-order-close.service';
import { WorkOrderQueryService } from './work-order/work-order-query.service';
import { WorkOrderReleaseService } from './work-order/work-order-release.service';
import { WorkOrderResourcePlanService } from './work-order/work-order-resource-plan.service';
import { WorkOrderTransitionService } from './work-order/work-order-transition.service';
import { WorkOrderWriteService } from './work-order/work-order-write.service';
import { WorkOrderController } from './work-order/work-order.controller';

/**
 * 생산 도메인 — W/O(I-6). 발행이 채번을, 중단·재개가 상태기계를 부른다(PR ④).
 * 배포(PR ⑤b)가 LOT 코어를 부르고 자재 출고요청 표에 직접 쓴다.
 * 마감·취소(PR ⑥b)가 LOT 생명주기 코어와 ERP 아웃박스 코어를 부른다.
 * 생산 실적 조회(I-7 PR ①)는 읽기만 한다 — 코어를 부르지 않는다.
 * 실적 등록(PR ②)은 채번 코어와 LOT 생명주기 코어(L1)를 부른다 — 원장은 지나지 않는다.
 * 정정·상신(PR ③)이 승인 코어를 부른다 — 상신만 코어를 타고, 정정의 승인 게이트는
 * 「승인이 필수」라 뜻이 반대라 도메인 안에 선다(§5-5).
 */
@Module({
  imports: [
    PrismaModule,
    IdempotencyModule,
    NumberingModule,
    DocumentStateModule,
    LotRegistryModule,
    OutboxModule,
    ApprovalModule,
  ],
  controllers: [WorkOrderController, ProductionResultController],
  providers: [
    WorkOrderQueryService,
    WorkOrderWriteService,
    WorkOrderTransitionService,
    WorkOrderReleaseService,
    WorkOrderCloseService,
    WorkOrderCancelService,
    WorkOrderResourcePlanService,
    ProductionResultQueryService,
    ProductionResultService,
    ProductionResultCorrectService,
    ProductionResultApprovalService,
  ],
})
export class ProductionModule {}
