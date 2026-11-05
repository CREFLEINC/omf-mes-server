import { Body, Controller, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { MaterialIssueRequestQueryService } from '../material-issue-request/material-issue-request-query.service';
import { MaterialIssueRequestView } from '../material-issue-request/material-issue-request-view';
import { userOf } from './replenishment-item.controller';
import { ReplenishmentRequestCreate, ReplenishmentRequestService, SkippedLineView } from './replenishment-request.service';

/** 생산 창고 보충 — 직접 요청(W-02-12 · 피처 004). 응답의 요청은 목록과 같은 모양이다(조회 서비스로 다시 읽는다). */
@Controller('logistics/replenishment-requests')
export class ReplenishmentRequestController {
  constructor(
    private readonly requests: ReplenishmentRequestService,
    private readonly queries: MaterialIssueRequestQueryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Contract('POST /logistics/replenishment-requests')
  create(
    @Req() request: Request,
    @Body() body: ReplenishmentRequestCreate,
  ): Promise<{ requests: MaterialIssueRequestView[]; skippedLines: SkippedLineView[] }> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () => {
      const created = await this.requests.create(body, appUserId);
      return { requests: await this.queries.headers(created.requestIds.map(Number)), skippedLines: created.skippedLines };
    });
  }
}
