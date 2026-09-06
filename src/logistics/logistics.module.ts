import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { InventoryPostingModule } from '../core/inventory-posting';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { AsnController } from './asn/asn.controller';
import { AsnQueryService } from './asn/asn-query.service';
import { DocumentProgressModule } from './document-progress/document-progress.module';
import { GoodsIssueController } from './goods-issue/goods-issue.controller';
import { GoodsIssueQueryService } from './goods-issue/goods-issue-query.service';
import { GoodsIssueUpdateService } from './goods-issue/goods-issue-update.service';
import { GoodsIssueService } from './goods-issue/goods-issue.service';
import { GoodsReceiptController } from './goods-receipt/goods-receipt.controller';
import { GoodsReceiptService } from './goods-receipt/goods-receipt.service';
import { InboundReceiptQueryService } from './inbound-receipt/inbound-receipt-query.service';
import {
  InboundReceiptController,
  InboundReceiptSplitController,
} from './inbound-receipt/inbound-receipt.controller';
import { InboundReceiptSplitService } from './inbound-receipt/inbound-receipt-split.service';
import { InboundReceiptUpdateService } from './inbound-receipt/inbound-receipt-update.service';
import { InboundReceiptService } from './inbound-receipt/inbound-receipt.service';
import { InboundVarianceController } from './inbound-receipt/inbound-variance.controller';
import { InboundVarianceService } from './inbound-receipt/inbound-variance.service';
import { MaterialIssueRequestController } from './material-issue-request/material-issue-request.controller';
import { MaterialIssueRequestQueryService } from './material-issue-request/material-issue-request-query.service';
import { MaterialIssueRequestService } from './material-issue-request/material-issue-request.service';
import { MaterialIssueShortageService } from './material-issue-request/shortage.service';
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
  imports: [
    PrismaModule,
    IdempotencyModule,
    InventoryPostingModule,
    NumberingModule,
    ApprovalModule,
    DocumentStateModule,
    LotRegistryModule,
    DocumentProgressModule,
  ],
  controllers: [
    GoodsIssueController,
    GoodsReceiptController,
    PutawayRuleController,
    PurchaseOrderController,
    AsnController,
    InboundReceiptController,
    InboundReceiptSplitController,
    InboundVarianceController,
    MaterialIssueRequestController,
  ],
  providers: [
    GoodsIssueQueryService,
    GoodsIssueService,
    GoodsIssueUpdateService,
    GoodsReceiptService,
    PutawayRuleService,
    PurchaseOrderService,
    PurchaseOrderQueryService,
    AsnQueryService,
    InboundReceiptService,
    InboundReceiptQueryService,
    InboundReceiptUpdateService,
    InboundReceiptSplitService,
    InboundVarianceService,
    MaterialIssueRequestQueryService,
    MaterialIssueShortageService,
    MaterialIssueRequestService,
  ],
})
export class LogisticsModule {}
