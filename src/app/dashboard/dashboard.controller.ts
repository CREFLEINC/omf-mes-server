import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { DashboardSummaryQuery, DashboardSummaryService } from './dashboard-summary.service';
import { DashboardSummary } from './dashboard-view';

/**
 * 통합 대시보드 — 카드마다 소유 화면이 따로 있고 여기는 숫자만 모은다. 기능 권한 없이 로그인만 본다
 * (omf-all-around#229 · 계약이 403 을 선언하지 않는다). 볼 수 있는 공장 범위는 그대로 사용자 설정을 따른다.
 */
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
