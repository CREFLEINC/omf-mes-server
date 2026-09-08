import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import { ifMatchVersion, setEtag } from "../../common/optimistic-lock";
import { maintenanceOrderWriteContext } from "../order/order-write-context";
import { MaintenanceResultCreateService } from "./result-create.service";
import {
  MaintenanceResultList,
  MaintenanceResultQuery,
  MaintenanceResultQueryService,
} from "./result-query.service";
import { MaintenanceResultView } from "./result-view";
import { MaintenanceResultUpdateService } from "./result-update.service";
import {
  MaintenanceResultCreate,
  MaintenanceResultUpdate,
} from "./result-write-input";

@Controller("maintenance/results")
export class MaintenanceResultController {
  constructor(
    private readonly queries: MaintenanceResultQueryService,
    private readonly creates: MaintenanceResultCreateService,
    private readonly updates: MaintenanceResultUpdateService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract("GET /maintenance/results")
  list(@Query() query: MaintenanceResultQuery): Promise<MaintenanceResultList> {
    return this.queries.list(query);
  }

  @Put(":maintenanceResultId")
  @Contract("PUT /maintenance/results/{maintenanceResultId}")
  @HttpCode(HttpStatus.OK)
  async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param("maintenanceResultId", ParseIntPipe) maintenanceResultId: number,
    @Body() body: MaintenanceResultUpdate,
  ): Promise<MaintenanceResultView> {
    const version = ifMatchVersion(request);
    if (version === undefined)
      throw new Error("If-Match 가 없는데 가드를 지났습니다.");
    const context = maintenanceOrderWriteContext(request, HttpStatus.OK);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.updates.updateWithin(
        tx,
        maintenanceResultId,
        version,
        body,
        context.appUserId,
      ),
    );
    setEtag(response, outcome.body.versionNo);
    return outcome.body.view;
  }

  @Post()
  @Contract("POST /maintenance/results")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() request: Request,
    @Body() body: MaintenanceResultCreate,
  ): Promise<MaintenanceResultView> {
    const context = maintenanceOrderWriteContext(request, HttpStatus.CREATED);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.creates.createWithin(
        tx,
        body,
        context.appUserId,
        ifMatchVersion(request),
      ),
    );
    return outcome.body;
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
