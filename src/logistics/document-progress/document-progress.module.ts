import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { CancelEligibilityService } from './cancel-eligibility.service';
import { DocumentTypeRegistryChecker } from './document-type-registry';

/**
 * 물류 문서 진행현황 — 조회 2건과 취소 2건이 «같은 판정 함수»를 쓴다(I-5.md §4-1).
 * 판정 서비스는 Prisma 를 받지 않는다 — 호출자가 연 `tx` 로만 돈다. 부팅 대조만 Prisma 를 쓴다.
 */
@Module({
  imports: [PrismaModule],
  providers: [CancelEligibilityService, DocumentTypeRegistryChecker],
  exports: [CancelEligibilityService],
})
export class DocumentProgressModule {}
