import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency';
import { ApprovalModule } from '../../core/approval';
import { DocumentStateModule } from '../../core/document-state';
import { NumberingModule } from '../../core/numbering';
import { PrismaModule } from '../../prisma/prisma.module';
import { CancelEligibilityService } from './cancel-eligibility.service';
import { DocumentCancelService } from './document-cancel.service';
import { DocumentProgressController } from './document-progress.controller';
import { DocumentProgressQueryService } from './document-progress-query.service';
import { DocumentTypeRegistryChecker } from './document-type-registry';

/**
 * 물류 문서 진행현황 — 조회 2건과 취소 2건이 «같은 판정 함수»를 쓴다(I-5.md §4-1).
 * 판정 서비스는 Prisma 를 받지 않는다 — 호출자가 연 `tx` 로만 돈다. 부팅 대조만 Prisma 를 쓴다.
 * 취소 요청은 코어 셋(승인·채번·상태기계)에만 기댄다 — 입하·입고·출고 도메인 service 는 안 부른다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule, ApprovalModule, NumberingModule, DocumentStateModule],
  controllers: [DocumentProgressController],
  providers: [
    CancelEligibilityService,
    DocumentCancelService,
    DocumentTypeRegistryChecker,
    DocumentProgressQueryService,
  ],
  exports: [CancelEligibilityService],
})
export class DocumentProgressModule {}
