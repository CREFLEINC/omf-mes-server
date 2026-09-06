import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { MaterialIssueRequestQuery, MaterialIssueRequestQueryService } from './material-issue-request-query.service';
import { MaterialIssueRequestDetail, MaterialIssueRequestView } from './material-issue-request-view';
import { MaterialIssueShortageLine, MaterialIssueShortageService } from './shortage.service';

/**
 * 자재 출고요청 조회 3건 — `M-01-08` 이 목록·상세를, `W-02-10` 이 `shortage` 로 표를 읽는다.
 * 계약이 목록·상세에 403 을 안 선언해 그 둘은 권한표에 없다(`shortage` 만
 * `derived-permissions.ts:56` 이 `W-02-10` 으로 갖는다).
 */
@Controller('logistics/material-issue-requests')
export class MaterialIssueRequestController {
  constructor(
    private readonly queries: MaterialIssueRequestQueryService,
    private readonly shortages: MaterialIssueShortageService,
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

  @Get(':materialIssueRequestId')
  @Contract('GET /logistics/material-issue-requests/{materialIssueRequestId}')
  get(
    @Param('materialIssueRequestId', ParseIntPipe) materialIssueRequestId: number,
  ): Promise<MaterialIssueRequestDetail> {
    return this.queries.get(materialIssueRequestId);
  }
}
