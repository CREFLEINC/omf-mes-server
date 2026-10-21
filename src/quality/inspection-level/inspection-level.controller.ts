import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  InspectionLevelService,
  ItemInspectionLevelCreate,
  ItemInspectionLevelHistoryQuery,
  ItemInspectionLevelHistoryView,
  ItemInspectionLevelQuery,
  ItemInspectionLevelUpdate,
  ItemInspectionLevelView,
} from './inspection-level.service';

/** 품목별 IQC 검사 수준(omf-all-around#64 · 장부 P-87). 화면은 품질 관리 › 검사 수준 관리(`W-03-12`)다. */
@Controller('quality')
export class InspectionLevelController {
  constructor(
    private readonly levels: InspectionLevelService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('item-inspection-levels')
  @Contract('GET /quality/item-inspection-levels')
  list(@Query() query: ItemInspectionLevelQuery): Promise<PagedResponse<ItemInspectionLevelView>> {
    return this.levels.list(query);
  }

  @Post('item-inspection-levels')
  @Contract('POST /quality/item-inspection-levels')
  create(@Req() request: Request, @Body() body: ItemInspectionLevelCreate): Promise<ItemInspectionLevelView> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.levels.create(body, currentSession(request)?.userId),
    );
  }

  @Put('item-inspection-levels/:itemInspectionLevelId')
  @Contract('PUT /quality/item-inspection-levels/{itemInspectionLevelId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemInspectionLevelId', ParseIntPipe) id: number,
    @Body() body: ItemInspectionLevelUpdate,
  ): Promise<ItemInspectionLevelView> {
    return runVersioned<ItemInspectionLevelView, 'itemInspectionLevel'>(
      this.idempotency,
      request,
      response,
      'itemInspectionLevel',
      (version) => this.levels.update(id, version, body, currentSession(request)?.userId),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Get('item-inspection-level-histories')
  @Contract('GET /quality/item-inspection-level-histories')
  histories(@Query() query: ItemInspectionLevelHistoryQuery): Promise<PagedResponse<ItemInspectionLevelHistoryView>> {
    return this.levels.histories(query);
  }
}
