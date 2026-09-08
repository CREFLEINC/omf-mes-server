import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import {
  BreakdownList,
  BreakdownQuery,
  BreakdownQueryService,
} from './breakdown-query.service';
import { BreakdownView } from './breakdown-view';
import {
  BreakdownCreate,
  BreakdownCreateService,
} from './breakdown-create.service';
import { breakdownWriteContext } from './breakdown-write-context';

@Controller('maintenance/breakdowns')
export class BreakdownController {
  constructor(
    private readonly queries: BreakdownQueryService,
    private readonly creates: BreakdownCreateService,
  ) {}

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

  @Post()
  @Contract('POST /maintenance/breakdowns')
  create(
    @Req() request: Request,
    @Body() body: BreakdownCreate,
  ): Promise<BreakdownView> {
    return this.creates.create(body, breakdownWriteContext(request));
  }
}
