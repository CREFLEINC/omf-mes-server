import { Body, Controller, Get, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import { ifMatchVersion, setEtag } from "../../common/optimistic-lock";
import { CollectionChannelCreateService } from "./collection-channel-create.service";
import {
  CollectionChannelList,
  CollectionChannelObservationList,
  CollectionChannelObservationQuery,
  CollectionChannelQuery,
  CollectionChannelQueryService,
} from "./collection-channel-query.service";
import { CollectionChannelView } from "./collection-channel-view";
import { CollectionChannelUpdateService } from "./collection-channel-update.service";
import { collectionChannelWriteContext } from "./collection-channel-write-context";
import {
  CollectionChannelCreate,
  CollectionChannelUpdate,
} from "./collection-channel-write-input";

@Controller("maintenance/collection-channels")
export class CollectionChannelController {
  constructor(
    private readonly queries: CollectionChannelQueryService,
    private readonly creates: CollectionChannelCreateService,
    private readonly updates: CollectionChannelUpdateService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract("GET /maintenance/collection-channels")
  list(@Query() query: CollectionChannelQuery): Promise<CollectionChannelList> {
    return this.queries.list(query);
  }

  @Get("observations")
  @Contract("GET /maintenance/collection-channels/observations")
  observations(
    @Query() query: CollectionChannelObservationQuery,
  ): Promise<CollectionChannelObservationList> {
    return this.queries.observations(query);
  }

  @Post()
  @Contract("POST /maintenance/collection-channels")
  async create(
    @Req() request: Request,
    @Body() body: CollectionChannelCreate,
  ): Promise<CollectionChannelView> {
    const context = collectionChannelWriteContext(request, 201);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.creates.createWithin(tx, body, context),
    );
    return outcome.body;
  }

  @Put(":collectionChannelId")
  @Contract("PUT /maintenance/collection-channels/{collectionChannelId}")
  async update(
    @Req() request: Request,
    @Param("collectionChannelId") collectionChannelId: number,
    @Body() body: CollectionChannelUpdate,
  ): Promise<CollectionChannelView> {
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error("If-Match 가 없는데 가드를 지났습니다.");
    }
    const context = collectionChannelWriteContext(request, 200);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.updates.updateWithin(tx, collectionChannelId, version, body, context),
    );
    return outcome.body;
  }

  @Get(":collectionChannelId")
  @Contract("GET /maintenance/collection-channels/{collectionChannelId}")
  async get(
    @Param("collectionChannelId") collectionChannelId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CollectionChannelView> {
    const { view, versionNo } = await this.queries.get(collectionChannelId);
    setEtag(response, versionNo);
    return view;
  }
}
