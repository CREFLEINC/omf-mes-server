import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import { ifMatchVersion, setEtag } from "../../common/optimistic-lock";
import { MaintenanceOrderCancelService } from "./order-cancel.service";
import {
  MaintenanceOrderList,
  MaintenanceOrderQuery,
  MaintenanceOrderQueryService,
} from "./order-query.service";
import { MaintenanceOrderView } from "./order-view";
import { maintenanceOrderWriteContext } from "./order-write-context";

@Controller("maintenance/orders")
export class MaintenanceOrderController {
  constructor(
    private readonly queries: MaintenanceOrderQueryService,
    private readonly cancels: MaintenanceOrderCancelService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  @Post(":maintenanceOrderId\\:cancel")
  @Contract("POST /maintenance/orders/{maintenanceOrderId}:cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Req() request: Request,
    @Param("maintenanceOrderId", ParseIntPipe) maintenanceOrderId: number,
  ): Promise<MaintenanceOrderView> {
    const version = requiredVersion(request);
    const context = maintenanceOrderWriteContext(request, HttpStatus.OK);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.cancels.cancelWithin(tx, maintenanceOrderId, version, context),
    );
    return outcome.body;
  }
}

function requiredVersion(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined)
    throw new Error("If-Match 가 없는데 가드를 지났습니다.");
  return version;
}
