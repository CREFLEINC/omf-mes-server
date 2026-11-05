import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import { ShopfloorReceiptDetail } from '../shopfloor-receipt/shopfloor-receipt-view';
import { userOf } from './replenishment-item.controller';
import { ArrivalBulkReceive, ArrivalQuery, ArrivalReceive, BulkResult, ReplenishmentArrivalService } from './replenishment-arrival.service';

/**
 * 생산 창고 보충 — 도착 대기·수령(W-02-12 · 피처 004). 웹 개별 수령을 따로 두는 이유: `POST /shopfloor-receipts` 의 권한
 * (`M-01-09`)은 도출표에 있어 넓힐 수 없고, 넓히면 W-02-12 역할이 W/O 출고까지 받는다(contracts §2).
 * ⛔ 컬렉션 액션(`/shopfloor-receipts:bulk`)이 있어 접두어를 짧게 잡는다(`inbound-receipts:split` 선례).
 */
@Controller('logistics')
export class ReplenishmentArrivalController {
  constructor(
    private readonly arrivals: ReplenishmentArrivalService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('replenishment-requests/arrivals')
  @Contract('GET /logistics/replenishment-requests/arrivals')
  list(@Query() query: ArrivalQuery): Promise<PagedResponse<unknown>> {
    return this.arrivals.list(query);
  }

  @Post('replenishment-requests/arrivals/:goodsIssueId\\:receive')
  @Contract('POST /logistics/replenishment-requests/arrivals/{goodsIssueId}:receive')
  receive(
    @Req() request: Request,
    @Param('goodsIssueId', ParseIntPipe) goodsIssueId: number,
    @Body() body: ArrivalReceive,
  ): Promise<ShopfloorReceiptDetail> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.arrivals.receive(goodsIssueId, body, appUserId));
  }

  @Post('shopfloor-receipts\\:bulk')
  @Contract('POST /logistics/shopfloor-receipts:bulk')
  @HttpCode(HttpStatus.OK)
  bulk(@Req() request: Request, @Body() body: ArrivalBulkReceive): Promise<{ results: BulkResult[] }> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.arrivals.bulk(body, appUserId));
  }
}
