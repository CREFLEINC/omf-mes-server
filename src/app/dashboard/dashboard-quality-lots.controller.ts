import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import {
  DashboardQualityLots,
  DashboardQualityLotsQuery,
  DashboardQualityLotsService,
} from './dashboard-quality-lots.service';

/**
 * 품질 「현재 현황」 상태별 LOT 목록(omf-all-around#118 · #251 에서 계약에 옮김). 대시보드 요약과 같은 권한 —
 * 기능 권한 없이 로그인만 본다(omf-all-around#229 · `LOGIN_ONLY_OPERATIONS`), 403 은 데이터 범위 밖 공장뿐이다.
 */
@Controller('app/dashboard-quality-lots')
export class DashboardQualityLotsController {
  constructor(private readonly lots: DashboardQualityLotsService) {}

  @Get()
  @Contract('GET /app/dashboard-quality-lots')
  read(@Req() request: Request, @Query() query: DashboardQualityLotsQuery): Promise<DashboardQualityLots> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return this.lots.read(session.userId, query);
  }
}
