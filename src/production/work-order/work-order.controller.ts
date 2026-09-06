import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { WorkOrderDetailQuery, WorkOrderQueryService } from './work-order-query.service';
import { WorkOrderResourcePlanView, WorkOrderView } from './work-order-view';

/**
 * W/O 조회 — 상세 + 4M 계획 배정 목록(I-6 PR ①). 질의 파라미터의 형·enum 검증은 계약 검증
 * 가드(`@Contract`)가 이미 한다 — 여기서 다시 검사하지 않는다.
 * ⛔ 권한 가드가 안 본다 — 계약이 두 오퍼레이션에 403 을 선언하지 않았다(`plan.md` §5 규칙 1).
 */
@Controller('production/work-orders')
export class WorkOrderController {
  constructor(private readonly queries: WorkOrderQueryService) {}

  @Get(':workOrderId')
  @Contract('GET /production/work-orders/{workOrderId}')
  async detail(
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Query() query: WorkOrderDetailQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkOrderView> {
    const { view, versionNo } = await this.queries.detail(workOrderId, query);
    setEtag(response, versionNo);
    return view;
  }

  @Get(':workOrderId/resource-plans')
  @Contract('GET /production/work-orders/{workOrderId}/resource-plans')
  async resourcePlans(@Param('workOrderId', ParseIntPipe) workOrderId: number): Promise<{ items: WorkOrderResourcePlanView[] }> {
    return { items: await this.queries.resourcePlans(workOrderId) };
  }
}
