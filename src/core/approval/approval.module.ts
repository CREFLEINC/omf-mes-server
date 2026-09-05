import { Module } from '@nestjs/common';

import { DocumentStateModule } from '../document-state';
import { ApprovalService } from './approval.service';

/** Prisma 는 받지 않는다 — 호출자가 연 `tx` 로만 돈다(한 오퍼레이션이 한 트랜잭션). */
@Module({
  imports: [DocumentStateModule],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
