import { Controller, Get, Param } from "@nestjs/common";

import { Contract } from "../../common/contract";
import { CalibrationQueryService } from "./calibration-query.service";
import { CalibrationView } from "./calibration-view";

@Controller("maintenance/calibrations")
export class CalibrationController {
  constructor(private readonly queries: CalibrationQueryService) {}

  @Get(":calibrationId")
  @Contract("GET /maintenance/calibrations/{calibrationId}")
  get(@Param("calibrationId") calibrationId: number): Promise<CalibrationView> {
    return this.queries.get(calibrationId);
  }
}
