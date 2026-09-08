import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import { DowntimeSummaryCalendarService } from "./downtime-summary-calendar.service";
import { DowntimeSummaryMaintenanceService } from "./downtime-summary-maintenance.service";
import { DowntimeSummaryMinorService } from "./downtime-summary-minor.service";
import { DowntimeSummarySourceService } from "./downtime-summary-source.service";
import {
  DowntimeSummaryQuery,
  DowntimeSummaryView,
  downtimeSummaryView,
} from "./downtime-summary-view";

@Injectable()
export class DowntimeSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: DowntimeSummarySourceService,
    private readonly minor: DowntimeSummaryMinorService,
    private readonly calendars: DowntimeSummaryCalendarService,
    private readonly maintenance: DowntimeSummaryMaintenanceService,
  ) {}

  read(query: DowntimeSummaryQuery): Promise<DowntimeSummaryView> {
    return this.prisma.$transaction(
      async (tx) => {
        const source = await this.sources.readWithin(tx, query);
        const thresholds = await this.minor.resolveWithin(
          tx,
          source.plants,
          query.startedTo,
        );
        const plannedUs = await this.calendars.resolveWithin(
          tx,
          source.plants,
          source.equipment,
          query.startedFrom,
          query.startedTo,
        );
        const maintenance = await this.maintenance.resolveWithin(
          tx,
          source.plants,
          source.equipment,
          query.equipmentId !== undefined ||
            query.equipmentGroupId !== undefined,
        );
        return downtimeSummaryView(
          source,
          thresholds,
          plannedUs,
          maintenance,
          query,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
