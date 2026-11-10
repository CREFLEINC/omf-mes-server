import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { DashboardItemGroupDefects, DashboardItemGroupDefectsService } from './dashboard-item-group-defects.service';
import type { DashboardSummaryQuery } from './dashboard-summary.service';

/** 제품군별 불량 현황 — 대시보드 요약과 같은 질의 · 같은 권한(로그인만 · 범위 밖 공장 403). */
@Controller('app/dashboard-item-group-defects')
export class DashboardItemGroupDefectsController {
  constructor(private readonly defects: DashboardItemGroupDefectsService) {}

  @Get()
  @Contract('GET /app/dashboard-item-group-defects')
  read(@Req() request: Request, @Query() query: DashboardSummaryQuery): Promise<DashboardItemGroupDefects> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return this.defects.read(session.userId, query);
  }
}
