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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import { MaterialIssueRequestQuery, MaterialIssueRequestQueryService } from './material-issue-request-query.service';
import { MaterialIssueRequestDetail, MaterialIssueRequestView } from './material-issue-request-view';
import { MaterialIssueRequestCreate, MaterialIssueRequestService } from './material-issue-request.service';
import { FreeStockQuery, FreeStockRow, FreeStockService } from './free-stock.service';
import { PlannedStockQuery, PlannedStockService } from './planned-stock.service';
import { MaterialIssueShortageLine, MaterialIssueShortageService } from './shortage.service';

/**
 * 자재 출고요청 4건 — `M-01-08` 이 목록·상세를, `W-02-10` 이 `shortage` 와 발행 `POST` 를 쓴다.
 * 계약이 목록·상세에 403 을 안 선언해 그 둘은 권한표에 없다(`shortage` 는
 * `derived-permissions.ts:56`, `POST` 는 `:175` 가 `W-02-10` 으로 이미 갖는다 — 추가 0).
 */
@Controller('logistics/material-issue-requests')
export class MaterialIssueRequestController {
  constructor(
    private readonly queries: MaterialIssueRequestQueryService,
    private readonly shortages: MaterialIssueShortageService,
    private readonly requests: MaterialIssueRequestService,
    private readonly idempotency: IdempotencyService,
    private readonly plannedStock: PlannedStockService,
    private readonly freeStock: FreeStockService,
  ) {}

  @Get()
  @Contract('GET /logistics/material-issue-requests')
  list(@Query() query: MaterialIssueRequestQuery): Promise<PagedResponse<MaterialIssueRequestView>> {
    return this.queries.list(query);
  }

  /** ⭐ `:materialIssueRequestId` **앞**이다 — Nest 는 선언 순서로 매칭하므로 뒤에 두면
   *  `shortage` 가 식별자로 잡혀 400 이 난다. */
  @Get('shortage')
  @Contract('GET /logistics/material-issue-requests/shortage')
  shortage(
    @Query() query: { workOrderId?: unknown },
  ): Promise<{ items: MaterialIssueShortageLine[] }> {
    return this.shortages.shortage(query);
  }

  /** 생산 창고 예정·부족(피처 003) — 역시 `:materialIssueRequestId` 앞이다. */
  @Get('planned-stock')
  @Contract('GET /logistics/material-issue-requests/planned-stock')
  plannedStockRows(@Query() query: PlannedStockQuery): Promise<unknown> {
    return this.plannedStock.query(query);
  }

  /** 창고·품목별 쓸 수 있는 양(W-02-10 남은 수량 · omf-all-around#232) — 역시 `:materialIssueRequestId` 앞이다. */
  @Get('free-stock')
  @Contract('GET /logistics/material-issue-requests/free-stock')
  freeStockRows(@Query() query: FreeStockQuery): Promise<{ items: FreeStockRow[] }> {
    return this.freeStock.query(query);
  }

  @Get(':materialIssueRequestId')
  @Contract('GET /logistics/material-issue-requests/{materialIssueRequestId}')
  get(
    @Param('materialIssueRequestId', ParseIntPipe) materialIssueRequestId: number,
  ): Promise<MaterialIssueRequestDetail> {
    return this.queries.get(materialIssueRequestId);
  }

  /**
   * 발행. ⛔ **ETag 를 안 내린다** — 계약 201 에 `headers` 가 없어 `runVersioned` 를 쓸 수
   * 없다(그 헬퍼가 `setEtag` 를 부른다 · §4-7). ⛔ `If-Match` 는 「선택」이라 **받되 무시한다** —
   * 신규 생성이라 대조할 `version_no` 가 아직 없다. 400 도 내지 않는다(I-7 §4-6 선례).
   */
  @Post()
  @Contract('POST /logistics/material-issue-requests')
  create(
    @Req() request: Request,
    @Body() body: MaterialIssueRequestCreate,
  ): Promise<unknown> {
    const appUserId = userOf(request);
    // 응답은 조회와 같은 모양(이름·화면 값)이다 — 만든 뒤 조회 서비스로 다시 읽는다(피처 003 · W-02-10).
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () => {
      const created = await this.requests.create(body, appUserId);
      const ids = created.requests.map((row) => row.materialIssueRequestId);
      return { ...(await this.queries.get(ids[0])), requests: await this.queries.headers(ids) };
    });
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
