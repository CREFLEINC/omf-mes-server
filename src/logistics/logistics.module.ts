import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { InventoryPostingModule } from '../core/inventory-posting';
import { LotRegistryModule } from '../core/lot';
import { NumberingModule } from '../core/numbering';
import { OutboxModule } from '../core/outbox';
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
import { PickingController } from './picking/picking.controller';
import { PickingPickService } from './picking/picking-pick.service';
import { PickingQueryService } from './picking/picking-query.service';
import { PutawayCompleteService } from './putaway/putaway-complete.service';
import { PutawayRuleController } from './putaway/putaway-rule.controller';
import { PutawayRuleService } from './putaway/putaway-rule.service';
import { PutawayTaskController } from './putaway/putaway-task.controller';
import { PutawayTaskService } from './putaway/putaway-task.service';
import { PurchaseOrderQueryService } from './purchase-order/purchase-order-query.service';
import { PurchaseOrderController } from './purchase-order/purchase-order.controller';
import { PurchaseOrderService } from './purchase-order/purchase-order.service';
import { RecycleEntryController } from './recycle-entry/recycle-entry.controller';
import { RecycleEntryService } from './recycle-entry/recycle-entry.service';
import { SalesOrderQueryService } from './sales-order/sales-order-query.service';
import { SalesOrderController } from './sales-order/sales-order.controller';
import { AllocationPackingService } from './shipment-allocation/allocation-packing.service';
import { ShipmentAllocationQueryService } from './shipment-allocation/shipment-allocation-query.service';
import { ShipmentAllocationController } from './shipment-allocation/shipment-allocation.controller';
import { ShippingUnitQueryService } from './shipping-unit/shipping-unit-query.service';
import { ShippingUnitController } from './shipping-unit/shipping-unit.controller';
import { ShippingUnitService } from './shipping-unit/shipping-unit.service';
import { ShipmentQueryService } from './shipment/shipment-query.service';
import { ShipmentController } from './shipment/shipment.controller';
import { ShipmentCancelService } from './shipment/shipment-cancel.service';
import { StockReinstatementController } from './stock-reinstatement/stock-reinstatement.controller';
import { StockReinstatementService } from './stock-reinstatement/stock-reinstatement.service';
import { ShipmentConfirmService } from './shipment/shipment-confirm.service';
import { ShipmentService } from './shipment/shipment.service';
import { ShipmentPickService } from './shipment-request/shipment-pick.service';
import { ShipmentRequestQueryService } from './shipment-request/shipment-request-query.service';
import { ShipmentRequestController } from './shipment-request/shipment-request.controller';
import { ShipmentRequestService } from './shipment-request/shipment-request.service';
import { ShopfloorReceiptController } from './shopfloor-receipt/shopfloor-receipt.controller';
import { ShopfloorReceiptQueryService } from './shopfloor-receipt/shopfloor-receipt-query.service';
import { ShopfloorReceiptService } from './shopfloor-receipt/shopfloor-receipt.service';
import { StockTransferQueryService } from './stock-transfer/stock-transfer-query.service';
import { StockTransferService } from './stock-transfer/stock-transfer.service';
import { StockTransferController } from './stock-transfer/stock-transfer.controller';
import { TransferArriveService } from './stock-transfer/transfer-arrive.service';

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
    // ⭐ 출하 확정(I-23)이 ERP 송신을 적재한다 — 물류가 아웃박스를 쓰는 첫 자리다.
    OutboxModule,
    LotRegistryModule,
    DocumentProgressModule,
  ],
  controllers: [
    GoodsIssueController,
    GoodsReceiptController,
    PickingController,
    PutawayRuleController,
    PutawayTaskController,
    PurchaseOrderController,
    SalesOrderController,
    ShipmentAllocationController,
    ShippingUnitController,
    ShipmentRequestController,
    ShipmentController,
    StockReinstatementController,
    AsnController,
    InboundReceiptController,
    InboundReceiptSplitController,
    InboundVarianceController,
    MaterialIssueRequestController,
    RecycleEntryController,
    ShopfloorReceiptController,
    StockTransferController,
  ],
  providers: [
    GoodsIssueQueryService,
    GoodsIssueService,
    GoodsIssueUpdateService,
    GoodsReceiptService,
    PickingPickService,
    PickingQueryService,
    PutawayCompleteService,
    PutawayRuleService,
    PutawayTaskService,
    PurchaseOrderService,
    PurchaseOrderQueryService,
    SalesOrderQueryService,
    AllocationPackingService,
    ShipmentAllocationQueryService,
    ShippingUnitQueryService,
    ShippingUnitService,
    ShipmentPickService,
    ShipmentRequestQueryService,
    ShipmentRequestService,
    ShipmentQueryService,
    ShipmentService,
    ShipmentConfirmService,
    ShipmentCancelService,
    StockReinstatementService,
    AsnQueryService,
    InboundReceiptService,
    InboundReceiptQueryService,
    InboundReceiptUpdateService,
    InboundReceiptSplitService,
    InboundVarianceService,
    MaterialIssueRequestQueryService,
    MaterialIssueShortageService,
    MaterialIssueRequestService,
    RecycleEntryService,
    ShopfloorReceiptQueryService,
    ShopfloorReceiptService,
    StockTransferQueryService,
    StockTransferService,
    TransferArriveService,
  ],
})
export class LogisticsModule {}
