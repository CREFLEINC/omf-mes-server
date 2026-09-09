import { Controller, Get, Param, Query } from "@nestjs/common";

import { Contract } from "../../common/contract";
import {
  CalibrationList,
  CalibrationQuery,
  CalibrationQueryService,
} from "./calibration-query.service";
import { CalibrationView } from "./calibration-view";

@Controller("maintenance/calibrations")
export class CalibrationController {
  constructor(private readonly queries: CalibrationQueryService) {}

  @Get()
  @Contract("GET /maintenance/calibrations")
  list(@Query() query: CalibrationQuery): Promise<CalibrationList> {
    return this.queries.list(query);
  }

  @Get(":calibrationId")
  @Contract("GET /maintenance/calibrations/{calibrationId}")
  get(@Param("calibrationId") calibrationId: number): Promise<CalibrationView> {
    return this.queries.get(calibrationId);
  }
}
