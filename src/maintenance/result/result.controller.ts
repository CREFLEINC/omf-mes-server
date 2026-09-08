import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { Contract } from "../../common/contract";
import { setEtag } from "../../common/optimistic-lock";
import {
  MaintenanceResultList,
  MaintenanceResultQuery,
  MaintenanceResultQueryService,
} from "./result-query.service";
import { MaintenanceResultView } from "./result-view";

@Controller("maintenance/results")
export class MaintenanceResultController {
  constructor(private readonly queries: MaintenanceResultQueryService) {}

  @Get()
  @Contract("GET /maintenance/results")
  list(@Query() query: MaintenanceResultQuery): Promise<MaintenanceResultList> {
    return this.queries.list(query);
  }

  @Get(":maintenanceResultId")
  @Contract("GET /maintenance/results/{maintenanceResultId}")
  async get(
    @Param("maintenanceResultId", ParseIntPipe) maintenanceResultId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MaintenanceResultView> {
    const { view, versionNo } = await this.queries.get(maintenanceResultId);
    setEtag(response, versionNo);
    return view;
  }
}
