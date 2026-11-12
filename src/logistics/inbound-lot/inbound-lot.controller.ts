import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import {
  InboundLotLotsService, InboundLotSupplierLotResult, InboundLotSupplierLotSet, InboundLotUnregister,
} from './inbound-lot-lots.service';
import { InboundLotCloseReceipt, InboundLotCloseService, InboundLotClosedView } from './inbound-lot-close';
import { InboundLotDetailView, InboundLotQuery, InboundLotQueryService } from './inbound-lot-query.service';
import { InboundLotReopenReceipt, InboundLotReopenService } from './inbound-lot-reopen.service';
import { InboundLotReceive, InboundLotReceiveResult, InboundLotReceiveService } from './inbound-lot-receive.service';
import {
  InboundLotSplitLots, InboundLotSplitPreviewView, InboundLotSplitResultView, InboundLotSplitService,
} from './inbound-lot-split.service';
import { InboundLotView } from './inbound-lot-view';

const RECEIVE = 'POST /logistics/inbound-lots:receive';
const UNREGISTER = 'POST /logistics/inbound-lots/{inboundLotId}:unregister-lots';
const SUPPLIER_LOT_NO = 'PATCH /logistics/inbound-lots/{inboundLotId}/lots/supplier-lot-no';
const CLOSE_RECEIPT = 'POST /logistics/inbound-lots/{inboundLotId}:close-receipt';
const REOPEN_RECEIPT = 'POST /logistics/inbound-lots/{inboundLotId}:reopen-receipt';
const SPLIT_LOTS = 'POST /logistics/inbound-lots/{inboundLotId}:split-lots';

/** 입하 LOT — 조회(§2)·PDA 받기·해제·공급사 LOT·마감·마감 취소·자재 관리 LOT 분리(§3). 피처 005 · 화면 M-01-01·M-01-03·W-01-16·W-01-01. */
@Controller('logistics')
export class InboundLotController {
  constructor(
    private readonly receives: InboundLotReceiveService,
    private readonly lots: InboundLotLotsService,
    private readonly queries: InboundLotQueryService,
    private readonly closer: InboundLotCloseService,
    private readonly reopener: InboundLotReopenService,
    private readonly splitter: InboundLotSplitService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('inbound-lots')
  @Contract('GET /logistics/inbound-lots')
  list(@Req() request: Request, @Query() query: InboundLotQuery): Promise<PagedResponse<InboundLotView>> {
    // 단말은 자기 공장만 — 범위 검사가 다른 공장 `plantId` 를 이미 막았다.
    const terminal = currentTerminal(request);
    return this.queries.list({ ...query, plantId: terminal === undefined ? Number(query.plantId) : Number(terminal.plantId) });
  }

  @Get('inbound-lots/:inboundLotId')
  @Contract('GET /logistics/inbound-lots/{inboundLotId}')
  get(@Param('inboundLotId', ParseIntPipe) inboundLotId: number): Promise<InboundLotDetailView> {
    return this.queries.get(inboundLotId);
  }

  @Post('inbound-lots\\:receive')
  @Contract(RECEIVE)
  receive(@Req() request: Request, @Body() body: InboundLotReceive): Promise<InboundLotReceiveResult> {
    const actor = logisticsWriteActorOf(request, RECEIVE);
    return this.receives.receive(request, body, actor, currentTerminal(request)?.plantId);
  }

  @Post('inbound-lots/:inboundLotId\\:unregister-lots')
  @HttpCode(HttpStatus.OK)
  @Contract(UNREGISTER)
  unregister(
    @Req() request: Request,
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Body() body: InboundLotUnregister,
  ): Promise<InboundLotView> {
    const actor = logisticsWriteActorOf(request, UNREGISTER);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.lots.unregister(tx, inboundLotId, body, actor));
  }

  @Patch('inbound-lots/:inboundLotId/lots/supplier-lot-no')
  @Contract(SUPPLIER_LOT_NO)
  setSupplierLotNo(
    @Req() request: Request,
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Body() body: InboundLotSupplierLotSet,
  ): Promise<InboundLotSupplierLotResult> {
    const actor = logisticsWriteActorOf(request, SUPPLIER_LOT_NO);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.lots.setSupplierLotNo(tx, inboundLotId, body, actor));
  }

  @Post('inbound-lots/:inboundLotId\\:close-receipt')
  @HttpCode(HttpStatus.OK)
  @Contract(CLOSE_RECEIPT)
  closeReceipt(
    @Req() request: Request,
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Body() body: InboundLotCloseReceipt,
  ): Promise<InboundLotClosedView> {
    return this.closer.close(request, inboundLotId, body, logisticsWriteActorOf(request, CLOSE_RECEIPT));
  }

  @Post('inbound-lots/:inboundLotId\\:reopen-receipt')
  @HttpCode(HttpStatus.OK)
  @Contract(REOPEN_RECEIPT)
  reopenReceipt(
    @Req() request: Request,
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Body() body: InboundLotReopenReceipt,
  ): Promise<InboundLotView> {
    const actor = logisticsWriteActorOf(request, REOPEN_RECEIPT);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.reopener.reopen(tx, inboundLotId, body, actor));
  }

  @Get('inbound-lots/:inboundLotId/split-preview')
  @Contract('GET /logistics/inbound-lots/{inboundLotId}/split-preview')
  splitPreview(
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Query('lotIds') lotIds: unknown,
  ): Promise<InboundLotSplitPreviewView> {
    // 계약 검사가 쉼표 목록·반복 키를 정수 배열로 이미 맞췄다.
    return this.splitter.preview(inboundLotId, [lotIds].flat().map(Number));
  }

  @Post('inbound-lots/:inboundLotId\\:split-lots')
  @Contract(SPLIT_LOTS)
  splitLots(
    @Req() request: Request,
    @Param('inboundLotId', ParseIntPipe) inboundLotId: number,
    @Body() body: InboundLotSplitLots,
  ): Promise<InboundLotSplitResultView> {
    return this.splitter.split(request, inboundLotId, body, logisticsWriteActorOf(request, SPLIT_LOTS));
  }
}
