import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { StockTransferQuery, StockTransferQueryService } from './stock-transfer-query.service';
import { StockTransferDetail, StockTransferLineView, StockTransferView } from './stock-transfer-view';

/**
 * 재고 이동 6건 중 조회 3건(PR ①). 등록·도착·라인 치환은 PR ②③④ 가 잇는다.
 * `M-01-10` 이 소유하는 화면 — 조회는 계약이 403 을 선언하지 않아 `manual-permissions.ts`
 * 에 없다(`permission.guard.ts:35-40`).
 */
@Controller('logistics/stock-transfers')
export class StockTransferController {
  constructor(private readonly queries: StockTransferQueryService) {}

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

  /** ⛔ 자식 컬렉션 GET 이라 ETag 를 안 붙인다(계약 원문 — 잠그는 단위는 부모다). */
  @Get(':stockTransferId/lines')
  @Contract('GET /logistics/stock-transfers/{stockTransferId}/lines')
  async lines(
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
  ): Promise<{ items: StockTransferLineView[] }> {
    return { items: await this.queries.lines(stockTransferId) };
  }
}
