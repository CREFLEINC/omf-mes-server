import { Controller, Get, Param, Query } from "@nestjs/common";

import { Contract } from "../../common/contract";
import {
  ToolUsageList,
  ToolUsageQuery,
  ToolUsageQueryService,
} from "./tool-usage-query.service";
import { ToolUsageView } from "./tool-usage-view";

@Controller("maintenance/tool-usages")
export class ToolUsageController {
  constructor(private readonly queries: ToolUsageQueryService) {}

  @Get()
  @Contract("GET /maintenance/tool-usages")
  list(@Query() query: ToolUsageQuery): Promise<ToolUsageList> {
    return this.queries.list(query);
  }

  @Get(":toolUsageId")
  @Contract("GET /maintenance/tool-usages/{toolUsageId}")
  get(@Param("toolUsageId") toolUsageId: number): Promise<ToolUsageView> {
    return this.queries.get(toolUsageId);
  }
}
