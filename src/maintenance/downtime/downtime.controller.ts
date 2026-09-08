import {
  Body,
  Controller,
  Get,
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
import { DowntimeCreateService } from "./downtime-create.service";
import {
  DowntimeList,
  DowntimeQuery,
  DowntimeQueryService,
} from "./downtime-query.service";
import type { DowntimeCreate, DowntimeUpdate } from "./downtime-rules";
import { DowntimeUpdateService } from "./downtime-update.service";
import { DowntimeView } from "./downtime-view";
import {
  downtimeCreateContext,
  downtimeUpdateContext,
} from "./downtime-write-context";

@Controller("maintenance/downtimes")
export class DowntimeController {
  constructor(
    private readonly queries: DowntimeQueryService,
    private readonly creates: DowntimeCreateService,
    private readonly updates: DowntimeUpdateService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  @Post()
  @Contract("POST /maintenance/downtimes")
  async create(
    @Req() request: Request,
    @Body() body: DowntimeCreate,
  ): Promise<DowntimeView> {
    const context = downtimeCreateContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.creates.createWithin(tx, body, context),
    );
    return outcome.body;
  }

  @Put(":downtimeId")
  @Contract("PUT /maintenance/downtimes/{downtimeId}")
  async update(
    @Req() request: Request,
    @Param("downtimeId", ParseIntPipe) downtimeId: number,
    @Body() body: DowntimeUpdate,
  ): Promise<DowntimeView> {
    const version = ifMatchVersion(request);
    if (version === undefined)
      throw new Error(
        "If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다",
      );
    const context = downtimeUpdateContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.updates.updateWithin(tx, downtimeId, version, body, context),
    );
    return outcome.body;
  }
}
