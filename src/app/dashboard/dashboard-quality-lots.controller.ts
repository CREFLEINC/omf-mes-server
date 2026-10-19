import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import { assertOperationPermission } from '../../common/permissions';
import {
  DashboardQualityLots,
  DashboardQualityLotsQuery,
  DashboardQualityLotsService,
} from './dashboard-quality-lots.service';

/** 권한을 빌려 오는 오퍼레이션 — 품질 종합 숫자를 보는 화면이 그 숫자의 목록도 본다. */
const SUMMARY_OPERATION = 'GET /app/dashboard-summary';

/**
 * 품질 종합 「현재 현황」 상태별 LOT 목록(장부 P-58 · omf-all-around#118).
 * ⛔ 이 경로는 계약 사본에 없어 `@Contract` 를 달 수 없고, 그래서 인증·권한 가드가 이 핸들러를 보지 않는다.
 * 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401 · 오퍼레이션 권한 403)를 여기서 부른다.
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
    assertOperationPermission(session, SUMMARY_OPERATION);
    return this.lots.read(query);
  }
}
