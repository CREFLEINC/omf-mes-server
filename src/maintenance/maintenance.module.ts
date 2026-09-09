import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../common/idempotency";
import { DocumentStateModule } from "../core/document-state";
import { NumberingModule } from "../core/numbering";
import { PrismaModule } from "../prisma/prisma.module";
import { BreakdownController } from "./breakdown/breakdown.controller";
import { BreakdownCreateService } from "./breakdown/breakdown-create.service";
import { BreakdownHandlingService } from "./breakdown/breakdown-handling.service";
import { BreakdownQueryService } from "./breakdown/breakdown-query.service";
import { CalibrationController } from "./calibration/calibration.controller";
import { CalibrationClearService } from "./calibration/calibration-clear.service";
import { CalibrationCreateService } from "./calibration/calibration-create.service";
import { CalibrationQueryService } from "./calibration/calibration-query.service";
import { CollectionChannelController } from "./collection-channel/collection-channel.controller";
import { CollectionChannelCreateService } from "./collection-channel/collection-channel-create.service";
import { CollectionChannelQueryService } from "./collection-channel/collection-channel-query.service";
import { DowntimeController } from "./downtime/downtime.controller";
import { DowntimeCreateService } from "./downtime/downtime-create.service";
import { DowntimeQueryService } from "./downtime/downtime-query.service";
import { DowntimeUpdateService } from "./downtime/downtime-update.service";
import { DowntimeSummaryCalendarService } from "./downtime/downtime-summary-calendar.service";
import { DowntimeSummaryMaintenanceService } from "./downtime/downtime-summary-maintenance.service";
import { DowntimeSummaryMinorService } from "./downtime/downtime-summary-minor.service";
import { DowntimeSummarySourceService } from "./downtime/downtime-summary-source.service";
import { DowntimeSummaryService } from "./downtime/downtime-summary.service";
import { InspectionController } from "./inspection/inspection.controller";
import { InspectionQueryService } from "./inspection/inspection-query.service";
import { InspectionWriteService } from "./inspection/inspection-write.service";
import { NumberedMaintenanceWrite } from "./numbered-maintenance-write";
import { MaintenanceOrderController } from "./order/order.controller";
import { MaintenanceOrderCancelService } from "./order/order-cancel.service";
import { MaintenanceOrderCreateService } from "./order/order-create.service";
import { MaintenanceOrderQueryService } from "./order/order-query.service";
import { MaintenanceResultController } from "./result/result.controller";
import { MaintenanceResultCreateService } from "./result/result-create.service";
import { MaintenanceResultQueryService } from "./result/result-query.service";
import { MaintenanceResultUpdateService } from "./result/result-update.service";
import { ToolUsageController } from "./tool-usage/tool-usage.controller";
import { ToolUsageQueryService } from "./tool-usage/tool-usage-query.service";

@Module({
  imports: [
    PrismaModule,
    IdempotencyModule,
    NumberingModule,
    DocumentStateModule,
  ],
  controllers: [
    InspectionController,
    BreakdownController,
    DowntimeController,
    MaintenanceOrderController,
    MaintenanceResultController,
    ToolUsageController,
    CalibrationController,
    CollectionChannelController,
  ],
  providers: [
    InspectionQueryService,
    InspectionWriteService,
    NumberedMaintenanceWrite,
    BreakdownCreateService,
    BreakdownHandlingService,
    BreakdownQueryService,
    DowntimeQueryService,
    DowntimeCreateService,
    DowntimeUpdateService,
    DowntimeSummarySourceService,
    DowntimeSummaryMinorService,
    DowntimeSummaryCalendarService,
    DowntimeSummaryMaintenanceService,
    DowntimeSummaryService,
    MaintenanceOrderQueryService,
    MaintenanceOrderCreateService,
    MaintenanceOrderCancelService,
    MaintenanceResultCreateService,
    MaintenanceResultUpdateService,
    MaintenanceResultQueryService,
    ToolUsageQueryService,
    CalibrationQueryService,
    CalibrationCreateService,
    CalibrationClearService,
    CollectionChannelQueryService,
    CollectionChannelCreateService,
  ],
})
export class MaintenanceModule {}
