import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { InventoryPostingModule } from '../core/inventory-posting';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { AsnController } from './asn/asn.controller';
import { AsnQueryService } from './asn/asn-query.service';
import { GoodsReceiptController } from './goods-receipt/goods-receipt.controller';
import { GoodsReceiptService } from './goods-receipt/goods-receipt.service';
import { InboundReceiptQueryService } from './inbound-receipt/inbound-receipt-query.service';
import { InboundReceiptController } from './inbound-receipt/inbound-receipt.controller';
import { InboundReceiptService } from './inbound-receipt/inbound-receipt.service';
import { InboundVarianceController } from './inbound-receipt/inbound-variance.controller';
import { InboundVarianceService } from './inbound-receipt/inbound-variance.service';
import { PutawayRuleController } from './putaway/putaway-rule.controller';
import { PutawayRuleService } from './putaway/putaway-rule.service';
import { PurchaseOrderQueryService } from './purchase-order/purchase-order-query.service';
import { PurchaseOrderController } from './purchase-order/purchase-order.controller';
import { PurchaseOrderService } from './purchase-order/purchase-order.service';

/**
 * 계약 최상위 경로 `/logistics` — 입하·출고·적치·이동·출하·P/O 요청.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 */
@Module({
  // ⭐ 원장 코어가 처음 물리는 자리다 — 입고가 재고를 «쓰는» 첫 도메인이다.
  imports: [PrismaModule, IdempotencyModule, InventoryPostingModule, NumberingModule, ApprovalModule, LotRegistryModule],
  controllers: [
    GoodsReceiptController,
    PutawayRuleController,
    PurchaseOrderController,
    AsnController,
    InboundReceiptController,
    InboundVarianceController,
  ],
  providers: [
    GoodsReceiptService,
    PutawayRuleService,
    PurchaseOrderService,
    PurchaseOrderQueryService,
    AsnQueryService,
    InboundReceiptService,
    InboundReceiptQueryService,
    InboundVarianceService,
  ],
})
export class LogisticsModule {}
