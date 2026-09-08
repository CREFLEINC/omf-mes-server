import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../common/idempotency";
import { DocumentStateModule } from "../core/document-state";
import { NumberingModule } from "../core/numbering";
import { PrismaModule } from "../prisma/prisma.module";
import { BreakdownController } from "./breakdown/breakdown.controller";
import { BreakdownCreateService } from "./breakdown/breakdown-create.service";
import { BreakdownHandlingService } from "./breakdown/breakdown-handling.service";
import { BreakdownQueryService } from "./breakdown/breakdown-query.service";
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
import { MaintenanceOrderQueryService } from "./order/order-query.service";

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
  ],
})
export class MaintenanceModule {}
