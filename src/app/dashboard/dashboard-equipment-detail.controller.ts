import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import {
  DashboardEquipmentDetail,
  DashboardEquipmentDetailQuery,
  DashboardEquipmentDetailService,
} from './dashboard-equipment-detail.service';

/** 설비 상세 팝업 — 대시보드 요약과 같은 권한(로그인만 · 범위 밖 공장의 설비 403 · 없는 설비 404). */
@Controller('app/dashboard-equipment-detail')
export class DashboardEquipmentDetailController {
  constructor(private readonly details: DashboardEquipmentDetailService) {}

  @Get()
  @Contract('GET /app/dashboard-equipment-detail')
  read(@Req() request: Request, @Query() query: DashboardEquipmentDetailQuery): Promise<DashboardEquipmentDetail> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return this.details.read(session.userId, query);
  }
}
