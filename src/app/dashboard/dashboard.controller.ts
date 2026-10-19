import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { DashboardSummaryQuery, DashboardSummaryService } from './dashboard-summary.service';
import { DashboardSummary } from './dashboard-view';

/** 통합 대시보드. 화면은 `W-CO-05` 가 소유한다 — 카드마다 소유 화면이 따로 있고 여기는 숫자만 모은다. */
@Controller('app/dashboard-summary')
export class DashboardController {
  constructor(private readonly summaries: DashboardSummaryService) {}

  @Get()
  @Contract('GET /app/dashboard-summary')
  read(@Req() request: Request, @Query() query: DashboardSummaryQuery): Promise<DashboardSummary> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return this.summaries.read(session.userId, query);
  }
}
