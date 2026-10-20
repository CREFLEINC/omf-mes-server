import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import {
  DashboardQualityLots,
  DashboardQualityLotsQuery,
  DashboardQualityLotsService,
} from './dashboard-quality-lots.service';

/**
 * 품질 종합 「현재 현황」 상태별 LOT 목록(장부 P-58 · omf-all-around#118).
 * 권한은 같은 화면의 `GET /app/dashboard-summary` 것을 그대로 쓴다(`manual-permissions.ts`) — 품질 종합 숫자를
 * 보는 화면이 그 숫자의 목록도 본다.
 */
@Controller('app/dashboard-quality-lots')
export class DashboardQualityLotsController {
  constructor(private readonly lots: DashboardQualityLotsService) {}

  @Get()
  @Contract('GET /app/dashboard-quality-lots')
  read(@Req() request: Request, @Query() query: DashboardQualityLotsQuery): Promise<DashboardQualityLots> {
    // 계약이 세션 전용이라 인증 가드를 지났으면 세션이 있다.
    const session = currentSession(request);
    if (session === undefined) throw loginRequired();
    return this.lots.read(session.userId, query);
  }
}
