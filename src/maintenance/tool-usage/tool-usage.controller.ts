import { Controller, Get, Param } from "@nestjs/common";

import { Contract } from "../../common/contract";
import { ToolUsageQueryService } from "./tool-usage-query.service";
import { ToolUsageView } from "./tool-usage-view";

@Controller("maintenance/tool-usages")
export class ToolUsageController {
  constructor(private readonly queries: ToolUsageQueryService) {}

  @Get(":toolUsageId")
  @Contract("GET /maintenance/tool-usages/{toolUsageId}")
  get(@Param("toolUsageId") toolUsageId: number): Promise<ToolUsageView> {
    return this.queries.get(toolUsageId);
  }
}
