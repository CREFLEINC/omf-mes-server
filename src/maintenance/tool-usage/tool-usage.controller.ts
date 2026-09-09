import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import {
  ToolUsageCreateService,
  ToolUsageCreateView,
} from "./tool-usage-create.service";
import {
  ToolUsageList,
  ToolUsageQuery,
  ToolUsageQueryService,
} from "./tool-usage-query.service";
import { ToolUsageView } from "./tool-usage-view";
import { toolUsageWriteContext } from "./tool-usage-write-context";
import { ToolUsageCreate } from "./tool-usage-write-input";

@Controller("maintenance/tool-usages")
export class ToolUsageController {
  constructor(
    private readonly queries: ToolUsageQueryService,
    private readonly creates: ToolUsageCreateService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract("GET /maintenance/tool-usages")
  list(@Query() query: ToolUsageQuery): Promise<ToolUsageList> {
    return this.queries.list(query);
  }

  @Post()
  @Contract("POST /maintenance/tool-usages")
  async create(
    @Req() request: Request,
    @Body() body: ToolUsageCreate,
  ): Promise<ToolUsageCreateView> {
    const context = toolUsageWriteContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.creates.createWithin(tx, body, context),
    );
    return outcome.body;
  }

  @Get(":toolUsageId")
  @Contract("GET /maintenance/tool-usages/{toolUsageId}")
  get(@Param("toolUsageId") toolUsageId: number): Promise<ToolUsageView> {
    return this.queries.get(toolUsageId);
  }
}
