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
import { StockTransferQuery, StockTransferQueryService } from './stock-transfer-query.service';
import { StockTransferDetail, StockTransferLineView, StockTransferView } from './stock-transfer-view';
import { StockTransferCreate, StockTransferService } from './stock-transfer.service';

/**
 * 재고 이동 6건 중 조회 3건 + 반출 등록(PR ①②). 도착·라인 치환은 PR ③④ 가 잇는다.
 * `M-01-10` 이 소유하는 화면 — 조회는 계약이 403 을 선언하지 않아 `manual-permissions.ts`
 * 에 없다(`permission.guard.ts:35-40`).
 */
@Controller('logistics/stock-transfers')
export class StockTransferController {
  constructor(
    private readonly queries: StockTransferQueryService,
    private readonly transfers: StockTransferService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/stock-transfers')
  list(@Query() query: StockTransferQuery): Promise<PagedResponse<StockTransferView>> {
    return this.queries.list(query);
  }

  @Get(':stockTransferId')
  @Contract('GET /logistics/stock-transfers/{stockTransferId}')
  async get(
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockTransferDetail> {
    const { stockTransfer, lines, versionNo } = await this.queries.get(stockTransferId);
    setEtag(response, versionNo);
    return { stockTransfer, lines };
  }

  /**
   * ⭐ 생성과 반출이 한 오퍼레이션이다 — 201 이 나온 시점에 원장 1단째가 이미 서 있다.
   * ⛔ If-Match 는 「선택」이라 꺼내지 않는다 — 새 자원이라 대조할 버전이 없다(C-9 · 출고 선례).
   */
  @Post()
  @Contract('POST /logistics/stock-transfers')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: StockTransferCreate,
  ): Promise<StockTransferDetail> {
    const appUserId = userOf(request);
    const workerNo = request.header('X-Worker-No') ?? undefined;
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.transfers.create(body, workerNo, appUserId),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }

  /** ⛔ 자식 컬렉션 GET 이라 ETag 를 안 붙인다(계약 원문 — 잠그는 단위는 부모다). */
  @Get(':stockTransferId/lines')
  @Contract('GET /logistics/stock-transfers/{stockTransferId}/lines')
  async lines(
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
  ): Promise<{ items: StockTransferLineView[] }> {
    return { items: await this.queries.lines(stockTransferId) };
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
