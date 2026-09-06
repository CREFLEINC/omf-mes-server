import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { ValidationReport, validateWorkOrder } from './validation';
import { WorkOrderDetailQuery, WorkOrderQueryService } from './work-order-query.service';
import { WorkOrderResourcePlanCreate, WorkOrderResourcePlanService } from './work-order-resource-plan.service';
import { WorkOrderResourcePlanView, WorkOrderView } from './work-order-view';

/**
 * W/O 조회 + 4M 계획 배정 쓰기·유효성 점검(I-6 PR ①·③). 질의·본문의 형·enum 검증은 계약
 * 검증 가드(`@Contract`)가 이미 한다 — 여기서 다시 검사하지 않는다.
 * ⛔ 권한 가드는 `validation` 에서만 본다 — 계약이 나머지 넷에 403 을 선언하지 않았다
 * (`plan.md` §5 규칙 1).
 */
@Controller('production/work-orders')
export class WorkOrderController {
  constructor(
    private readonly queries: WorkOrderQueryService,
    private readonly resourcePlans: WorkOrderResourcePlanService,
    private readonly idempotency: IdempotencyService,
    // 점검은 서비스 클래스를 안 세운다 — `validation.ts` 의 함수가 정본이고 ② 목록도 그것을 부른다.
    private readonly prisma: PrismaService,
  ) {}

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
  async resourcePlanList(@Param('workOrderId', ParseIntPipe) workOrderId: number): Promise<{ items: WorkOrderResourcePlanView[] }> {
    return { items: await this.queries.resourcePlans(workOrderId) };
  }

  @Post(':workOrderId/resource-plans')
  @Contract('POST /production/work-orders/{workOrderId}/resource-plans')
  addResourcePlan(
    @Req() request: Request,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Body() body: WorkOrderResourcePlanCreate,
  ): Promise<WorkOrderResourcePlanView> {
    // ⛔ ETag 를 안 싣는다 — 계약이 201 에 선언하지 않았다.
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.resourcePlans.add(workOrderId, body, currentSession(request)?.userId),
    );
  }

  @Delete(':workOrderId/resource-plans/:workOrderResourcePlanId')
  @Contract('DELETE /production/work-orders/{workOrderId}/resource-plans/{workOrderResourcePlanId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeResourcePlan(
    @Req() request: Request,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Param('workOrderResourcePlanId', ParseIntPipe) workOrderResourcePlanId: number,
  ): Promise<void> {
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.resourcePlans.remove(workOrderId, workOrderResourcePlanId);
      return undefined;
    });
  }

  @Get(':workOrderId/validation')
  @Contract('GET /production/work-orders/{workOrderId}/validation')
  validation(@Param('workOrderId', ParseIntPipe) workOrderId: number): Promise<ValidationReport> {
    return validateWorkOrder(this.prisma, workOrderId);
  }
}
