import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { InventoryPostingModule } from '../core/inventory-posting';
import { PrismaModule } from '../prisma/prisma.module';
import { GoodsReceiptController } from './goods-receipt/goods-receipt.controller';
import { GoodsReceiptService } from './goods-receipt/goods-receipt.service';
import { PutawayRuleController } from './putaway/putaway-rule.controller';
import { PutawayRuleService } from './putaway/putaway-rule.service';

/**
 * 계약 최상위 경로 `/logistics` — 입하·출고·적치·이동·출하 요청.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  // ⭐ 원장 코어가 처음 물리는 자리다 — 입고가 재고를 «쓰는» 첫 도메인이다.
  imports: [PrismaModule, IdempotencyModule, InventoryPostingModule],
  controllers: [GoodsReceiptController, PutawayRuleController],
  providers: [GoodsReceiptService, PutawayRuleService],
})
export class LogisticsModule {}
