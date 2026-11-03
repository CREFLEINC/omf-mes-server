import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import {
  DashboardQualityLots,
  DashboardQualityLotsQuery,
  DashboardQualityLotsService,
} from './dashboard-quality-lots.service';

/**
 * 품질 종합 「현재 현황」 상태별 LOT 목록(장부 P-58 · omf-all-around#118).
 * ⛔ 이 경로는 계약 사본에 없어 `@Contract` 를 달 수 없고, 그래서 인증 가드가 이 핸들러를 보지 않는다.
 * 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401)를 여기서 부른다. 기능 권한은 보지 않는다 —
 * 대시보드는 로그인한 사용자 누구나 본다(omf-all-around#229).
 * 정본에 경로가 실려 오면 `@Contract` 를 달고 이 수동 인증을 지운다.
 */
@Controller('app/dashboard-quality-lots')
export class DashboardQualityLotsController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly lots: DashboardQualityLotsService,
  ) {}

  @Get()
  async read(@Req() request: Request, @Query() query: DashboardQualityLotsQuery): Promise<DashboardQualityLots> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    return this.lots.read(session.userId, query);
  }
}
