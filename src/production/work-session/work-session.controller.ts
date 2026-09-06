import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  WorkSessionListQuery,
  WorkSessionQueryService,
} from './work-session-query.service';
import { WorkSessionEventView, WorkSessionView, WorkSessionWorkerView } from './work-session-view';

/**
 * 작업 세션 조회 4건(I-11 PR ①). 등록(`POST` 4건)은 PR ③·④ 몫이다.
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다 — 계약이 조회 5건 어디에도
 *    응답 헤더를 선언하지 않았다(I-11 §8).
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — 조회는 미선언이라 권한 표를
 *    손대지 않는다(`permission.guard.ts:37-41`).
 */
@Controller('production/work-sessions')
export class WorkSessionController {
  constructor(private readonly queries: WorkSessionQueryService) {}

  @Get()
  @Contract('GET /production/work-sessions')
  list(@Query() query: WorkSessionListQuery): Promise<PagedResponse<WorkSessionView>> {
    return this.queries.list(query);
  }

  @Get(':workSessionId')
  @Contract('GET /production/work-sessions/{workSessionId}')
  detail(@Param('workSessionId', ParseIntPipe) workSessionId: number): Promise<WorkSessionView> {
    return this.queries.detail(workSessionId);
  }

  @Get(':workSessionId/events')
  @Contract('GET /production/work-sessions/{workSessionId}/events')
  events(
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Query() query: { eventTypeCode?: string },
  ): Promise<WorkSessionEventView[]> {
    return this.queries.events(workSessionId, query);
  }

  @Get(':workSessionId/workers')
  @Contract('GET /production/work-sessions/{workSessionId}/workers')
  workers(
    @Param('workSessionId', ParseIntPipe) workSessionId: number,
    @Query() query: { active?: boolean },
  ): Promise<WorkSessionWorkerView[]> {
    return this.queries.workers(workSessionId, query);
  }
}
