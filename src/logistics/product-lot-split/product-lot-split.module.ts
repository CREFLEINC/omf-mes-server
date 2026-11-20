import { Module } from '@nestjs/common';

import { DocumentIssueWriteService } from '../../app/document-issue/document-issue-write.service';
import { IdempotencyModule } from '../../common/idempotency';
import { InventoryPostingModule } from '../../core/inventory-posting';
import { LotRegistryModule } from '../../core/lot';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProductLotSplitQueryService } from './product-lot-split-query.service';
import { ProductLotSplitController } from './product-lot-split.controller';
import { ProductLotSplitService } from './product-lot-split.service';

/** 생산 LOT 수량 분리(피처 013) — 발행 기록은 분리 트랜잭션 안에서 쓴다(`DocumentIssueWriteService` 는 의존이 없다). */
@Module({
  imports: [PrismaModule, IdempotencyModule, InventoryPostingModule, LotRegistryModule],
  controllers: [ProductLotSplitController],
  providers: [ProductLotSplitService, ProductLotSplitQueryService, DocumentIssueWriteService],
})
export class ProductLotSplitModule {}
