import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import { Contract } from "../../common/contract";
import {
  InspectionList,
  InspectionQuery,
  InspectionQueryService,
} from "./inspection-query.service";
import { InspectionView } from "./inspection-view";
import { InspectionCreate } from "./inspection-input";
import { inspectionWriteContext } from "./inspection-write-context";
import { InspectionWriteService } from "./inspection-write.service";

@Controller("maintenance/inspections")
export class InspectionController {
  constructor(
    private readonly queries: InspectionQueryService,
    private readonly writes: InspectionWriteService,
  ) {}

  @Get()
  @Contract("GET /maintenance/inspections")
  list(@Query() query: InspectionQuery): Promise<InspectionList> {
    return this.queries.list(query);
  }

  @Get(":inspectionId")
  @Contract("GET /maintenance/inspections/{inspectionId}")
  get(@Param("inspectionId") inspectionId: number): Promise<InspectionView> {
    return this.queries.get(inspectionId);
  }

  @Post()
  @Contract("POST /maintenance/inspections")
  create(
    @Req() request: Request,
    @Body() body: InspectionCreate,
  ): Promise<InspectionView> {
    return this.writes.create(body, inspectionWriteContext(request));
  }
}
