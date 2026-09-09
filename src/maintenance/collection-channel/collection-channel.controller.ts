import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";

import { Contract } from "../../common/contract";
import { setEtag } from "../../common/optimistic-lock";
import { CollectionChannelQueryService } from "./collection-channel-query.service";
import { CollectionChannelView } from "./collection-channel-view";

@Controller("maintenance/collection-channels")
export class CollectionChannelController {
  constructor(private readonly queries: CollectionChannelQueryService) {}

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
