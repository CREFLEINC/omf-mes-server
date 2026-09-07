import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import {
  BreakdownList,
  BreakdownQuery,
  BreakdownQueryService,
} from './breakdown-query.service';
import { BreakdownView } from './breakdown-view';

@Controller('maintenance/breakdowns')
export class BreakdownController {
  constructor(private readonly queries: BreakdownQueryService) {}

  @Get()
  @Contract('GET /maintenance/breakdowns')
  list(@Query() query: BreakdownQuery): Promise<BreakdownList> {
    return this.queries.list(query);
  }

  @Get(':breakdownId')
  @Contract('GET /maintenance/breakdowns/{breakdownId}')
  async get(
    @Param('breakdownId', ParseIntPipe) breakdownId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BreakdownView> {
    const { view, versionNo } = await this.queries.get(breakdownId);
    setEtag(response, versionNo);
    return view;
  }
}
