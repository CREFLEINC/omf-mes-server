import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { DocumentStateModule } from '../core/document-state';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { CauseCodeService } from './code/cause-code.service';
import { DefectCodeProcessService } from './code/defect-code-process.service';
import { DefectCodeService } from './code/defect-code.service';
import { CauseCodeController, DefectCodeController } from './code/quality-code.controller';
import { DefectDistributionService } from './defect/defect-distribution.service';
import { DefectRecordController } from './defect/defect-record.controller';
import { DefectRecordService } from './defect/defect-record.service';
import { InspectionPlanVersionController } from './inspection-plan/inspection-plan-version.controller';
import { InspectionPlanVersionService } from './inspection-plan/inspection-plan-version.service';
import { InspectionPlanController } from './inspection-plan/inspection-plan.controller';
import { InspectionPlanService } from './inspection-plan/inspection-plan.service';
import { InspectionConfirmService } from './inspection/inspection-confirm.service';
import { InspectionRequestController } from './inspection/inspection-request.controller';
import { InspectionRequestService } from './inspection/inspection-request.service';
import { InspectionResultController } from './inspection/inspection-result.controller';
import { InspectionResultQueryService } from './inspection/inspection-result-query.service';
import { InspectionResultWriteService } from './inspection/inspection-result-write.service';
import { InspectionMeasurementService } from './inspection/inspection-measurement.service';
import { InspectionSummaryController } from './inspection/inspection-summary.controller';
import { InspectionSummaryService } from './inspection/inspection-summary.service';
import { LotStatusController } from './lot-status/lot-status.controller';
import { LotStatusService } from './lot-status/lot-status.service';

/**
 * 계약 최상위 경로 `/quality` — 검사기준·불량/원인코드·판정·부적합·검사 의뢰·검사 결과 조회.
 * ⚠ 집계 2 + 측정치 2 는 **별도 컨트롤러**다(PR ⑤a·⑤b · R-18). `:confirm`(PR ④)이 LOT 세 표를 쓰므로 코어 둘
 * (`DocumentStateModule`·`LotRegistryModule`)을 함께 든다 — 도메인이 `trace` 를 직접 안 쓴다.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
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
  ],
  controllers: [
    DefectCodeController,
    CauseCodeController,
    InspectionPlanController,
    InspectionPlanVersionController,
    InspectionRequestController,
    // ⭐ `InspectionResultController` 보다 «먼저» — 라우트가 등록 순서로 잡혀, 뒤에 두면
    //   `/summary`·`/defect-rate-trend` 가 `:inspectionResultId`(ParseIntPipe)에 먼저 걸려 400 이다.
    InspectionSummaryController,
    InspectionResultController,
    DefectRecordController,
    LotStatusController, // 리터럴 경로 둘(`lot-statuses`·`lot-status-summary`) — 형제 파라미터 경로가 없어 순서 함정이 없다.
  ],
  providers: [
    DefectCodeService,
    CauseCodeService,
    DefectCodeProcessService,
    InspectionPlanService,
    InspectionPlanVersionService,
    InspectionRequestService,
    InspectionResultQueryService,
    InspectionResultWriteService,
    InspectionConfirmService,
    InspectionSummaryService,
    InspectionMeasurementService,
    DefectRecordService,
    DefectDistributionService,
    LotStatusService,
  ],
})
export class QualityModule {}
