import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { DocumentStateModule } from '../core/document-state';
import { InventoryPostingModule } from '../core/inventory-posting';
import { IqcHandoverNotifier, LotRegistryModule } from '../core/lot';
import { NotificationCoreModule } from '../core/notification';
import { NumberingModule } from '../core/numbering';
import { OutboxModule } from '../core/outbox';
import { PickingHandoverNotifier } from '../core/picking';
import { PrismaModule } from '../prisma/prisma.module';
import { LogisticsHandoverNotifier } from './logistics-handover';
import { AsnController } from './asn/asn.controller';
import { AsnQueryService } from './asn/asn-query.service';
import { DocumentProgressModule } from './document-progress/document-progress.module';
import { GoodsIssueController } from './goods-issue/goods-issue.controller';
import { GoodsIssueQueryService } from './goods-issue/goods-issue-query.service';
import { GoodsIssueUpdateService } from './goods-issue/goods-issue-update.service';
import { GoodsIssueService } from './goods-issue/goods-issue.service';
import { GoodsReceiptLineListController } from './goods-receipt/goods-receipt-line-list.controller';
import { GoodsReceiptLineListService } from './goods-receipt/goods-receipt-line-list.service';
import { GoodsReceiptController } from './goods-receipt/goods-receipt.controller';
import { ReceiptDefaultsController } from './goods-receipt/receipt-defaults.controller';
import { ReceiptDefaultsService } from './goods-receipt/receipt-defaults.service';
import { GoodsReceiptService } from './goods-receipt/goods-receipt.service';
import { InboundReceiptQueryService } from './inbound-receipt/inbound-receipt-query.service';
import {
  InboundReceiptController,
  InboundReceiptLineListController,
  InboundReceiptPerLineController,
  InboundReceiptSplitController,
} from './inbound-receipt/inbound-receipt.controller';
import { InboundAllocationController } from './inbound-receipt/inbound-allocation.controller';
import { InboundExcessController } from './inbound-receipt/inbound-excess.controller';
import { InboundAllocationService } from './inbound-receipt/inbound-allocation.service';
import { InboundExcessService } from './inbound-receipt/inbound-excess.service';
import { InboundReceiptLineListService } from './inbound-receipt/inbound-receipt-line-list.service';
import { InboundReceiptPerLineService } from './inbound-receipt/inbound-receipt-per-line.service';
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
import { PutawayTaskController } from './putaway/putaway-task.controller';
import { PutawayTaskService } from './putaway/putaway-task.service';
import { InboundProgressService } from './purchase-order/inbound-progress.service';
import { InboundStageCountController } from './purchase-order/inbound-stage-count.controller';
import { PurchaseOrderQueryService } from './purchase-order/purchase-order-query.service';
import { PurchaseOrderLineListController } from './purchase-order/purchase-order-line-list.controller';
import { PurchaseOrderLineListService } from './purchase-order/purchase-order-line-list.service';
import { PurchaseOrderController } from './purchase-order/purchase-order.controller';
import { PurchaseOrderService } from './purchase-order/purchase-order.service';
import { RecycleEntryController } from './recycle-entry/recycle-entry.controller';
import { RecycleEntryService } from './recycle-entry/recycle-entry.service';
import { SalesOrderQueryService } from './sales-order/sales-order-query.service';
import { SalesOrderController } from './sales-order/sales-order.controller';
import { AllocationPackingService } from './shipment-allocation/allocation-packing.service';
import { ShipmentAllocationQueryService } from './shipment-allocation/shipment-allocation-query.service';
import { ShipmentAllocationController } from './shipment-allocation/shipment-allocation.controller';
import { ShippingUnitBoxService } from './shipping-unit/shipping-unit-box.service';
import { ShippingUnitQueryService } from './shipping-unit/shipping-unit-query.service';
import { ShippingUnitController } from './shipping-unit/shipping-unit.controller';
import { ShippingUnitService } from './shipping-unit/shipping-unit.service';
import { ShipmentLineListController } from './shipment/shipment-line-list.controller';
import { ShipmentLineListService } from './shipment/shipment-line-list.service';
import { ShipmentQueryService } from './shipment/shipment-query.service';
import { ShipmentController } from './shipment/shipment.controller';
import { ShipmentCancelService } from './shipment/shipment-cancel.service';
import { LocationMoveController } from './location-move/location-move.controller';
import { LocationMoveService } from './location-move/location-move.service';
import { StockReinstatementController } from './stock-reinstatement/stock-reinstatement.controller';
import { StockReinstatementService } from './stock-reinstatement/stock-reinstatement.service';
import { ShipmentConfirmService } from './shipment/shipment-confirm.service';
import { ShipmentService } from './shipment/shipment.service';
import { ShipmentPickService } from './shipment-request/shipment-pick.service';
import { ShipmentOqcSkipService } from './shipment-request/shipment-oqc-skip.service';
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
    // 인계 작업 알림(omf-all-around#190) — 입고·이동·출고 요청·출하지시·출하가 같은 tx 에서 알림을 쓴다.
    NotificationCoreModule,
    // 계약 밖 경로(입하 초과분 · 입고 기본값)가 가드 밖이라 세션을 직접 푼다.
    AuthModule,
  ],
  controllers: [
    GoodsIssueController,
    GoodsReceiptController,
    ReceiptDefaultsController,
    GoodsReceiptLineListController,
    PickingController,
    PutawayTaskController,
    PurchaseOrderController,
    PurchaseOrderLineListController,
    InboundStageCountController,
    SalesOrderController,
    ShipmentAllocationController,
    ShippingUnitController,
    ShipmentRequestController,
    ShipmentController,
    ShipmentLineListController,
    StockReinstatementController,
    LocationMoveController,
    AsnController,
    InboundReceiptController,
    InboundReceiptLineListController,
    InboundReceiptPerLineController,
    InboundReceiptSplitController,
    InboundAllocationController,
    InboundExcessController,
    InboundVarianceController,
    MaterialIssueRequestController,
    RecycleEntryController,
    ShopfloorReceiptController,
    StockTransferController,
  ],
  providers: [
    LogisticsHandoverNotifier,
    PickingHandoverNotifier,
    IqcHandoverNotifier,
    GoodsIssueQueryService,
    GoodsIssueService,
    GoodsIssueUpdateService,
    GoodsReceiptService,
    GoodsReceiptLineListService,
    ReceiptDefaultsService,
    PickingPickService,
    PickingQueryService,
    PutawayCompleteService,
    PutawayTaskService,
    PurchaseOrderService,
    PurchaseOrderQueryService,
    PurchaseOrderLineListService,
    InboundProgressService,
    SalesOrderQueryService,
    AllocationPackingService,
    ShipmentAllocationQueryService,
    ShippingUnitBoxService,
    ShippingUnitQueryService,
    ShippingUnitService,
    ShipmentPickService,
    ShipmentOqcSkipService,
    ShipmentRequestQueryService,
    ShipmentRequestService,
    ShipmentQueryService,
    ShipmentLineListService,
    ShipmentService,
    ShipmentConfirmService,
    ShipmentCancelService,
    StockReinstatementService,
    LocationMoveService,
    AsnQueryService,
    InboundReceiptService,
    InboundReceiptQueryService,
    InboundReceiptUpdateService,
    InboundReceiptLineListService,
    InboundReceiptPerLineService,
    InboundReceiptSplitService,
    InboundAllocationService,
    InboundExcessService,
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
