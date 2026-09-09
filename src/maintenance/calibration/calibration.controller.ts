import { Body, Controller, Get, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import { CalibrationCreateService } from "./calibration-create.service";
import {
  CalibrationList,
  CalibrationQuery,
  CalibrationQueryService,
} from "./calibration-query.service";
import { CalibrationView } from "./calibration-view";
import { calibrationWriteContext } from "./calibration-write-context";
import { CalibrationCreate } from "./calibration-write-input";

@Controller("maintenance/calibrations")
export class CalibrationController {
  constructor(
    private readonly queries: CalibrationQueryService,
    private readonly creates: CalibrationCreateService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract("GET /maintenance/calibrations")
  list(@Query() query: CalibrationQuery): Promise<CalibrationList> {
    return this.queries.list(query);
  }

  @Post()
  @Contract("POST /maintenance/calibrations")
  async create(
    @Req() request: Request,
    @Body() body: CalibrationCreate,
  ): Promise<CalibrationView> {
    const context = calibrationWriteContext(request, HttpStatus.CREATED);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.creates.createWithin(tx, body, context),
    );
    return outcome.body;
  }

  @Get(":calibrationId")
  @Contract("GET /maintenance/calibrations/{calibrationId}")
  get(@Param("calibrationId") calibrationId: number): Promise<CalibrationView> {
    return this.queries.get(calibrationId);
  }
}
