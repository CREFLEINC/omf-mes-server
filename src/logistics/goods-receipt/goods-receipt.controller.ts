import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { GoodsReceiptQuery, GoodsReceiptService } from './goods-receipt.service';
import { GoodsReceiptCreate } from './receipt-posting';

/** 입고. 화면 `W-01-10`(처리) · `W-01-05`·`W-01-06`(조회). */
@Controller('logistics/goods-receipts')
export class GoodsReceiptController {
  constructor(
    private readonly receipts: GoodsReceiptService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/goods-receipts')
  list(@Query() query: GoodsReceiptQuery): Promise<PagedResponse<unknown>> {
    return this.receipts.list(query);
  }

  @Get(':goodsReceiptId')
  @Contract('GET /logistics/goods-receipts/{goodsReceiptId}')
  async get(
    @Param('goodsReceiptId', ParseIntPipe) goodsReceiptId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { detail, versionNo } = await this.receipts.get(goodsReceiptId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':goodsReceiptId/lines')
  @Contract('GET /logistics/goods-receipts/{goodsReceiptId}/lines')
  async lines(
    @Param('goodsReceiptId', ParseIntPipe) goodsReceiptId: number,
  ): Promise<{ items: unknown[] }> {
    return { items: await this.receipts.lines(goodsReceiptId) };
  }

  /** ⭐ 생성과 전기가 같은 순간이다 — 화면이 「입고 처리」 한 버튼이므로 오퍼레이션도 하나다. */
  @Post()
  @Contract('POST /logistics/goods-receipts')
  create(@Req() request: Request, @Body() body: GoodsReceiptCreate): Promise<unknown> {
    const userId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.receipts.create(body, userId),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
