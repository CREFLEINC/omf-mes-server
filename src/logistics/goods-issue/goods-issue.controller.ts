import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { GoodsIssueQuery, GoodsIssueQueryService } from './goods-issue-query.service';
import { GoodsIssueDetail, GoodsIssueLineView, GoodsIssueView } from './goods-issue-view';

/**
 * 출고 조회 3건. 화면은 `W-01-05`(반품)·`W-01-06`(기타 출고)·`P-01-02`(현장 QR)가 소유한다.
 * 등록·라인 치환·전기·상신은 PR ③④⑤ 가 같은 파일에 얹는다(계약이 조회 3건에 403 을
 * 선언하지 않아 `manual-permissions.ts` 를 안 건드린다 — I-4.md §1-2).
 */
@Controller('logistics/goods-issues')
export class GoodsIssueController {
  constructor(private readonly queries: GoodsIssueQueryService) {}

  @Get()
  @Contract('GET /logistics/goods-issues')
  list(@Query() query: GoodsIssueQuery): Promise<PagedResponse<GoodsIssueView>> {
    return this.queries.list(query);
  }

  @Get(':goodsIssueId')
  @Contract('GET /logistics/goods-issues/{goodsIssueId}')
  async get(
    @Param('goodsIssueId', ParseIntPipe) goodsIssueId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GoodsIssueDetail> {
    const { detail, versionNo } = await this.queries.get(goodsIssueId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':goodsIssueId/lines')
  @Contract('GET /logistics/goods-issues/{goodsIssueId}/lines')
  async lines(
    @Param('goodsIssueId', ParseIntPipe) goodsIssueId: number,
  ): Promise<{ items: GoodsIssueLineView[] }> {
    return { items: await this.queries.lines(goodsIssueId) };
  }
}
