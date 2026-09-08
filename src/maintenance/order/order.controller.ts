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
  MaintenanceOrderList,
  MaintenanceOrderQuery,
  MaintenanceOrderQueryService,
} from "./order-query.service";
import { MaintenanceOrderView } from "./order-view";

@Controller("maintenance/orders")
export class MaintenanceOrderController {
  constructor(private readonly queries: MaintenanceOrderQueryService) {}

  @Get()
  @Contract("GET /maintenance/orders")
  list(@Query() query: MaintenanceOrderQuery): Promise<MaintenanceOrderList> {
    return this.queries.list(query);
  }

  @Get(":maintenanceOrderId")
  @Contract("GET /maintenance/orders/{maintenanceOrderId}")
  async get(
    @Param("maintenanceOrderId", ParseIntPipe) maintenanceOrderId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MaintenanceOrderView> {
    const { view, versionNo } = await this.queries.get(maintenanceOrderId);
    setEtag(response, versionNo);
    return view;
  }
}
