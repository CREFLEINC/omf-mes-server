import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import {
  BreakdownComplete,
  BreakdownHandlingService,
  BreakdownHandlingUpdate,
} from './breakdown-handling.service';
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
import {
  breakdownManagementContext,
  breakdownWriteContext,
} from './breakdown-write-context';

@Controller('maintenance/breakdowns')
export class BreakdownController {
  constructor(
    private readonly queries: BreakdownQueryService,
    private readonly creates: BreakdownCreateService,
    private readonly handling: BreakdownHandlingService,
    private readonly idempotency: IdempotencyService,
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

  @Put(':breakdownId')
  @Contract('PUT /maintenance/breakdowns/{breakdownId}')
  async update(
    @Req() request: Request,
    @Param('breakdownId', ParseIntPipe) breakdownId: number,
    @Body() body: BreakdownHandlingUpdate,
  ): Promise<BreakdownView> {
    const version = requiredVersion(request);
    const context = breakdownManagementContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.handling.updateWithin(tx, breakdownId, version, body, context),
    );
    return outcome.body;
  }

  @Post(':breakdownId\\:start-handling')
  @Contract('POST /maintenance/breakdowns/{breakdownId}:start-handling')
  @HttpCode(HttpStatus.OK)
  async startHandling(
    @Req() request: Request,
    @Param('breakdownId', ParseIntPipe) breakdownId: number,
  ): Promise<BreakdownView> {
    const version = requiredVersion(request);
    const context = breakdownManagementContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.handling.startWithin(tx, breakdownId, version, context),
    );
    return outcome.body;
  }

  @Post(':breakdownId\\:complete')
  @Contract('POST /maintenance/breakdowns/{breakdownId}:complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Req() request: Request,
    @Param('breakdownId', ParseIntPipe) breakdownId: number,
    @Body() body: BreakdownComplete,
  ): Promise<BreakdownView> {
    const version = requiredVersion(request);
    const context = breakdownManagementContext(request);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.handling.completeWithin(tx, breakdownId, version, body, context),
    );
    return outcome.body;
  }
}

function requiredVersion(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났습니다.');
  }
  return version;
}
