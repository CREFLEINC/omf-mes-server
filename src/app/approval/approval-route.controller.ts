import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ApprovalRouteQuery, ApprovalRouteService } from './approval-route.service';
import { ApprovalRouteStepView, ApprovalRouteView } from './approval.mapper';

/**
 * 결재선 정의 조회 3건. 화면은 `W-06-15`(결재선 정의)가 소유한다.
 *
 * ⛔ 등록·수정·단계 치환(쓰기 3건)은 뒤 PR 이 이 컨트롤러에 핸들러를 **덧붙인다**
 * (A6 마이그레이션과 같은 PR). 이 PR 만으로는 결재선을 만들 방법이 없다.
 */
@Controller('app/approval-routes')
export class ApprovalRouteController {
  constructor(private readonly routes: ApprovalRouteService) {}

  @Get()
  @Contract('GET /app/approval-routes')
  list(@Query() query: ApprovalRouteQuery): Promise<PagedResponse<ApprovalRouteView>> {
    return this.routes.list(query);
  }

  @Get(':approvalRouteId')
  @Contract('GET /app/approval-routes/{approvalRouteId}')
  async get(
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApprovalRouteView> {
    const result = await this.routes.get(approvalRouteId);
    setEtag(response, result.versionNo);
    return result.route;
  }

  @Get(':approvalRouteId/steps')
  @Contract('GET /app/approval-routes/{approvalRouteId}/steps')
  async listSteps(
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
  ): Promise<{ items: ApprovalRouteStepView[] }> {
    return { items: await this.routes.listSteps(approvalRouteId) };
  }
}
