import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { CauseCodeService } from './code/cause-code.service';
import { DefectCodeService } from './code/defect-code.service';
import { CauseCodeController, DefectCodeController } from './code/quality-code.controller';

/**
 * 계약 최상위 경로 `/quality` — 검사기준·불량/원인코드·판정·부적합.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [DefectCodeController, CauseCodeController],
  providers: [DefectCodeService, CauseCodeService],
})
export class QualityModule {}
