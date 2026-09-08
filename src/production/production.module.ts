import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { OutboxModule } from '../core/outbox';
import { PrismaModule } from '../prisma/prisma.module';
import { MaterialConsumptionQueryService } from './material-consumption/material-consumption-query.service';
import { MaterialConsumptionController } from './material-consumption/material-consumption.controller';
import { MaterialConsumptionService } from './material-consumption/material-consumption.service';
import { MaterialReturnQueryService } from './material-return/material-return-query.service';
import { MaterialReturnController } from './material-return/material-return.controller';
import { OperationHandoverQueryService } from './operation-handover/operation-handover-query.service';
import { OperationHandoverController } from './operation-handover/operation-handover.controller';
import { OperationHandoverService } from './operation-handover/operation-handover.service';
import { PrecheckDecisionQueryService } from './precheck-decision/precheck-decision-query.service';
import { PrecheckDecisionController } from './precheck-decision/precheck-decision.controller';
import { MaterialReturnService } from './material-return/material-return.service';
import { PrecheckDecisionService } from './precheck-decision/precheck-decision.service';
import { RepairExecutionQueryService } from './repair-execution/repair-execution-query.service';
import { RepairExecutionController } from './repair-execution/repair-execution.controller';
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
import { WorkSessionEndService } from './work-session/work-session-end.service';
import { WorkSessionEventService } from './work-session/work-session-event.service';
import { WorkSessionQueryService } from './work-session/work-session-query.service';
import { WorkSessionWorkerService } from './work-session/work-session-worker.service';
import { WorkSessionController } from './work-session/work-session.controller';
import { WorkSessionService } from './work-session/work-session.service';

/**
 * 생산 도메인 — W/O(I-6). 발행이 채번을, 중단·재개가 상태기계를 부른다(PR ④).
 * 배포(PR ⑤b)가 LOT 코어를 부르고 자재 출고요청 표에 직접 쓴다.
 * 마감·취소(PR ⑥b)가 LOT 생명주기 코어와 ERP 아웃박스 코어를 부른다.
 * 생산 실적 조회(I-7 PR ①)는 읽기만 한다 — 코어를 부르지 않는다.
 * 실적 등록(PR ②)은 채번 코어와 LOT 생명주기 코어(L1)를 부른다 — 원장은 지나지 않는다.
 * 자재 투입·반출 조회(I-10 PR ①)는 읽기만 한다 — 코어를 부르지 않는다.
 * 투입 등록(PR ②)은 채번 코어만 부른다 — 원장·계보·LOT 생명주기를 지나지 않는다(§3-9·§3-13).
 * 자재 반출 등록(I-10 PR ③)은 채번 코어만 부른다 — ⛔ 원장을 지나지 않는다(§4-4 · 문의 051).
 * 정정·상신(PR ③)이 승인 코어를 부른다 — 상신만 코어를 타고, 정정의 승인 게이트는
 * 「승인이 필수」라 뜻이 반대라 도메인 안에 선다(§5-5).
 * 작업 세션·통제 판정 조회 5건(I-11 PR ①)은 읽기만 하고, 세션 열기·닫기(PR ③)는 상태기계
 * 코어만 부른다 — 원장·채번·승인은 지나지 않는다.
 * 사건 적재(PR ④)도 상태기계 코어만 부르고, 작업자 참여·이탈은 코어를 하나도 안 부른다.
 * 통제 판정 기록(I-11 PR ⑤)은 세션·전이표·단말 토큰을 하나도 안 쓴다 — 단일 INSERT.
 */
@Module({
  imports: [
    PrismaModule,
    // AuthModule 이 JwtModule 을 내보낸다 — 단말 토큰이 세션과 같은 비밀키로 서명된다.
    AuthModule,
    IdempotencyModule,
    NumberingModule,
    DocumentStateModule,
    LotRegistryModule,
    OutboxModule,
    ApprovalModule,
  ],
  controllers: [
    WorkOrderController,
    ProductionResultController,
    MaterialConsumptionController,
    MaterialReturnController,
    WorkSessionController,
    PrecheckDecisionController,
    OperationHandoverController,
    RepairExecutionController,
  ],
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
    MaterialConsumptionQueryService,
    MaterialConsumptionService,
    MaterialReturnQueryService,
    WorkSessionQueryService,
    WorkSessionService,
    WorkSessionEndService,
    WorkSessionEventService,
    WorkSessionWorkerService,
    PrecheckDecisionQueryService,
    MaterialReturnService,
    PrecheckDecisionService,
    OperationHandoverQueryService,
    RepairExecutionQueryService,
    OperationHandoverService,
  ],
})
export class ProductionModule {}
