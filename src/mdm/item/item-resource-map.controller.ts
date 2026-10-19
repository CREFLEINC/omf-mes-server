import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import {
  ItemResourceMapCreate,
  ItemResourceMapQuery,
  ItemResourceMapService,
  ItemResourceMapUpdate,
} from './item-resource-map.service';

/** 품목–공정–설비–금형 매핑. 화면은 `W-06-05` 품목 확장속성의 「설비·금형」 탭이다. */
@Controller('mdm/item-resource-maps')
export class ItemResourceMapController {
  constructor(
    private readonly maps: ItemResourceMapService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/item-resource-maps')
  list(@Query() query: ItemResourceMapQuery): Promise<unknown> {
    return this.maps.list(query);
  }

  @Post()
  @Contract('POST /mdm/item-resource-maps')
  create(@Req() request: Request, @Body() body: ItemResourceMapCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.maps.create(body, currentSession(request)?.userId),
    );
  }

  @Put(':itemResourceMapId')
  @Contract('PUT /mdm/item-resource-maps/{itemResourceMapId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemResourceMapId', ParseIntPipe) id: number,
    @Body() body: ItemResourceMapUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'itemResourceMap', (version) =>
      this.maps.update(id, version, body, currentSession(request)?.userId),
    );
  }
}
