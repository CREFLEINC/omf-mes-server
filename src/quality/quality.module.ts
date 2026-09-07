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
import { InspectionResultController } from './inspection/inspection-result.controller';
import { InspectionResultQueryService } from './inspection/inspection-result-query.service';

/**
 * 계약 최상위 경로 `/quality` — 검사기준·불량/원인코드·판정·부적합·검사 의뢰·검사 결과 조회.
 * ⚠ 검사 결과 쓰기(`POST`·`PUT`·`:confirm`)와 집계 3건은 PR ③④⑤ 가 이어서 배선한다.
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
    InspectionResultController,
  ],
  providers: [
    DefectCodeService,
    CauseCodeService,
    DefectCodeProcessService,
    InspectionPlanService,
    InspectionPlanVersionService,
    InspectionRequestService,
    InspectionResultQueryService,
  ],
})
export class QualityModule {}
