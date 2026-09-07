import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { CauseCodeService } from './code/cause-code.service';
import { DefectCodeProcessService } from './code/defect-code-process.service';
import { DefectCodeService } from './code/defect-code.service';
import { CauseCodeController, DefectCodeController } from './code/quality-code.controller';
import { InspectionPlanVersionController } from './inspection-plan/inspection-plan-version.controller';
import { InspectionPlanVersionService } from './inspection-plan/inspection-plan-version.service';
import { InspectionPlanController } from './inspection-plan/inspection-plan.controller';
import { InspectionPlanService } from './inspection-plan/inspection-plan.service';
import { InspectionRequestController } from './inspection/inspection-request.controller';
import { InspectionRequestService } from './inspection/inspection-request.service';

/**
 * 계약 최상위 경로 `/quality` — 검사기준·불량/원인코드·판정·부적합·검사 의뢰.
 * ⚠ 검사 결과(`inspection-results`)는 I-19 PR ②b 가 배선한다.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [
    DefectCodeController,
    CauseCodeController,
    InspectionPlanController,
    InspectionPlanVersionController,
    InspectionRequestController,
  ],
  providers: [
    DefectCodeService,
    CauseCodeService,
    DefectCodeProcessService,
    InspectionPlanService,
    InspectionPlanVersionService,
    InspectionRequestService,
  ],
})
export class QualityModule {}
