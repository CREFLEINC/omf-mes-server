import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { GoodsIssueQuery, GoodsIssueQueryService } from './goods-issue-query.service';
import { GoodsIssueCreate } from './goods-issue-rules';
import { GoodsIssueDetail, GoodsIssueLineView, GoodsIssueView } from './goods-issue-view';
import { GoodsIssueService, PostIssueRequest } from './goods-issue.service';

/**
 * 출고 조회 3건 + 등록 + 전기. 화면은 `W-01-05`(반품)·`W-01-06`(기타 출고)·`P-01-02`(현장 QR)·
 * `W-04-10`(제품 폐기)가 소유한다. 라인 치환·상신은 PR ⑤ 가 같은 파일에 얹는다(계약이 조회
 * 3건에 403 을 선언하지 않아 `manual-permissions.ts` 를 안 건드린다 — I-4.md §1-2. 등록의
 * 403 은 `derived-permissions.ts:169`, `:post` 는 :170 이 이미 갖는다).
 */
@Controller('logistics/goods-issues')
export class GoodsIssueController {
  constructor(
    private readonly queries: GoodsIssueQueryService,
    private readonly issues: GoodsIssueService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  /**
   * ⭐ 201 에 **ETag 를 내린다** — 입고 `POST /logistics/goods-receipts` 201 은 계약이 헤더를
   * 선언하지 않아 안 내렸다. 여기는 선언한다(I-4.md §1-1 · 입고를 베끼면 빠뜨리는 자리).
   * ⛔ If-Match 는 「선택」이라 꺼내지 않는다 — 새 자원이라 대조할 버전이 없다(§6-3).
   */
  @Post()
  @Contract('POST /logistics/goods-issues')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: GoodsIssueCreate,
  ): Promise<GoodsIssueDetail> {
    const appUserId = userOf(request);
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.issues.create(body, appUserId),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }

  /** ⭐ 200 은 상세가 아니라 헤더 하나(`GoodsIssue`)다 — ETag 도 안 내린다(계약 미선언). */
  @Post(':goodsIssueId\\:post')
  @Contract('POST /logistics/goods-issues/{goodsIssueId}:post')
  // 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다.
  @HttpCode(HttpStatus.OK)
  post(
    @Req() request: Request,
    @Param('goodsIssueId', ParseIntPipe) goodsIssueId: number,
    @Body() body: PostIssueRequest,
  ): Promise<GoodsIssueView> {
    // ⛔ `runVersioned` 를 못 쓴다 — 200 에 ETag 가 없어 새 토큰을 내릴 자리가 없다. 대신
    //    가드가 파싱해 둔 If-Match 값을 꺼내 서비스가 «비교만» 한다(P/O `:request-approval` 선례).
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.issues.post(goodsIssueId, version, body, appUserId),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
