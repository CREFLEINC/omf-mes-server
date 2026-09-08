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
  DowntimeList,
  DowntimeQuery,
  DowntimeQueryService,
} from "./downtime-query.service";
import { DowntimeView } from "./downtime-view";

@Controller("maintenance/downtimes")
export class DowntimeController {
  constructor(private readonly queries: DowntimeQueryService) {}

  @Get()
  @Contract("GET /maintenance/downtimes")
  list(@Query() query: DowntimeQuery): Promise<DowntimeList> {
    return this.queries.list(query);
  }

  @Get(":downtimeId")
  @Contract("GET /maintenance/downtimes/{downtimeId}")
  async get(
    @Param("downtimeId", ParseIntPipe) downtimeId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DowntimeView> {
    const { view, versionNo } = await this.queries.get(downtimeId);
    setEtag(response, versionNo);
    return view;
  }
}
