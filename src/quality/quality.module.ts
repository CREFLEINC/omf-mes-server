import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { NumberingModule } from '../core/numbering';
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
import { InspectionResultWriteService } from './inspection/inspection-result-write.service';

/**
 * 계약 최상위 경로 `/quality` — 검사기준·불량/원인코드·판정·부적합·검사 의뢰·검사 결과 조회.
 * ⚠ `:confirm` 과 집계 3건은 PR ④⑤ 가 이어서 배선한다.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [
    PrismaModule,
    // AuthModule 이 JwtModule 을 내보낸다 — 단말 토큰이 세션과 같은 비밀키로 서명된다.
    AuthModule,
    IdempotencyModule,
    NumberingModule,
  ],
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
    InspectionResultWriteService,
  ],
})
export class QualityModule {}
