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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ValidationReport, validateWorkOrder } from './validation';
import { WorkOrderListQuery } from './work-order-list-where';
import { WorkOrderDetailQuery, WorkOrderListItem, WorkOrderQueryService } from './work-order-query.service';
import { WorkOrderResourcePlanCreate, WorkOrderResourcePlanService } from './work-order-resource-plan.service';
import { WorkOrderListSummary } from './work-order-summary';
import {
  WorkOrderHold,
  WorkOrderResume,
  WorkOrderTransitionService,
} from './work-order-transition.service';
import { WorkOrderCreate, WorkOrderUpdate, WorkOrderWriteService } from './work-order-write.service';
import { WorkOrderResourcePlanView, WorkOrderView } from './work-order-view';

/**
 * W/O 조회 + 발행·수정·중단·재개 + 4M 계획 배정 쓰기·유효성 점검(I-6 PR ①·③·④).
 * 질의·본문의 형·enum 검증은 계약 검증 가드(`@Contract`)가 이미 한다 — 여기서 다시
 * 검사하지 않는다.
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — `validation`·`POST`·`PUT`·
 * `:hold`·`:resume` 다섯이고 그 매핑은 `derived-permissions.ts` 에 이미 있다(추가 0건 ·
 * `plan.md` §5 규칙 1).
 */
@Controller('production/work-orders')
export class WorkOrderController {
  constructor(
    private readonly queries: WorkOrderQueryService,
    private readonly writes: WorkOrderWriteService,
    private readonly transitions: WorkOrderTransitionService,
    private readonly resourcePlans: WorkOrderResourcePlanService,
    private readonly idempotency: IdempotencyService,
    // 점검은 서비스 클래스를 안 세운다 — `validation.ts` 의 함수가 정본이고 ② 목록도 그것을 부른다.
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /production/work-orders')
  list(@Query() query: WorkOrderListQuery): Promise<PagedResponse<WorkOrderListItem> & { summary?: WorkOrderListSummary }> {
    return this.queries.list(query);
  }

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

  /** ⭐ 201 에 ETag 를 싣는다 — 발행 직후 `:release`·`PUT` 이 그 토큰을 그대로 쓴다(계약). */
  @Post()
  @Contract('POST /production/work-orders')
  async create(
    @Req() request: Request,
    @Body() body: WorkOrderCreate,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkOrderView> {
    const created = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () => {
      const workOrderId = await this.writes.create(body, currentSession(request)?.userId);
      return this.queries.detail(workOrderId, {});
    });
    setEtag(response, created.versionNo);
    return created.view;
  }

  @Put(':workOrderId')
  @Contract('PUT /production/work-orders/{workOrderId}')
  update(
    @Req() request: Request,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Body() body: WorkOrderUpdate,
  ): Promise<WorkOrderView> {
    // ⛔ `runVersioned` 를 못 쓴다 — 계약이 200 에 ETag 를 선언하지 않아 새 토큰을 내릴
    //    자리가 없다. 다음 If-Match 는 본문의 `versionNo` 가 준다(R-22).
    const version = versionOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => {
      await this.writes.update(workOrderId, version, body, currentSession(request)?.userId);
      return (await this.queries.detail(workOrderId, {})).view;
    });
  }

  /** If-Match 가 **선택**이다(오프라인 대상 · C-9) — 없으면 `undefined` 로 내려보낸다. */
  @Post(':workOrderId\\:hold')
  @Contract('POST /production/work-orders/{workOrderId}:hold')
  // 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다.
  @HttpCode(HttpStatus.OK)
  hold(
    @Req() request: Request,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    @Body() body: WorkOrderHold,
  ): Promise<WorkOrderView> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => {
      await this.transitions.hold(workOrderId, ifMatchVersion(request), body);
      return (await this.queries.detail(workOrderId, {})).view;
    });
  }

  @Post(':workOrderId\\:resume')
  @Contract('POST /production/work-orders/{workOrderId}:resume')
  @HttpCode(HttpStatus.OK)
  resume(
    @Req() request: Request,
    @Param('workOrderId', ParseIntPipe) workOrderId: number,
    // 본문은 받되 저장할 칸이 없다 — 계약이 `occurredAt` 을 required 로 적었다(문의 035).
    @Body() _body: WorkOrderResume,
  ): Promise<WorkOrderView> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => {
      await this.transitions.resume(workOrderId, ifMatchVersion(request));
      return (await this.queries.detail(workOrderId, {})).view;
    });
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

/** `PUT` 은 If-Match 가 필수라 가드가 이미 막았다 — 여기 오면 값이 있다(형제 선례). */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}
