import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { AcknowledgeService, ProductionOrderAcknowledge } from './acknowledge.service';
import { AutoPlanResult, AutoPlanService } from './auto-plan.service';
import { ProductionOrderCreate, ProductionOrderCreateService } from './production-order-create.service';
import { ProductionOrderDetailQuery, ProductionOrderListQuery, ProductionOrderService } from './production-order.service';
import { ProductionOrderView } from './production-order-view';
import { ResyncService } from './resync.service';

/** ERP W/O 조회 2건(PR ①) + `:acknowledge`·`:resync`(PR ④) + 테스트용 등록(P-30). */
@Controller('planning/production-orders')
export class ProductionOrderController {
  constructor(
    private readonly queries: ProductionOrderService,
    private readonly acknowledges: AcknowledgeService,
    private readonly resyncs: ResyncService,
    private readonly creates: ProductionOrderCreateService,
    private readonly autoPlans: AutoPlanService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /planning/production-orders')
  list(@Query() query: ProductionOrderListQuery): Promise<PagedResponse<ProductionOrderView>> {
    return this.queries.list(query);
  }

  /**
   * ⛔ ETag 를 안 내린다 — 201 에 선언하지 않았다(`POST /planning/production-plans` 와 같다).
   * 자동 계획은 멱등 트랜잭션 «밖»에서 돈다 — 그 안에서 돌면 길어진 계획·전개가 멱등 기록을 롤백시켜 재전송이 중복 번호가 된다.
   * 그래서 멱등 기록에는 오더 id 만 남기고, 응답은 매번 지금 상태로 다시 읽는다(재전송도 그렇다).
   */
  @Post()
  @Contract('POST /planning/production-orders')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() request: Request, @Body() body: ProductionOrderCreate): Promise<ProductionOrderView> {
    const appUserId = currentSession(request)?.userId;
    const created = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.creates.create(body, appUserId), FAMILY_CONFLICT_CODE);
    if (created.autoPlan) await this.autoPlans.planReceived(created.productionOrderId, appUserId);
    return (await this.queries.detail(created.productionOrderId, {})).view;
  }

  @Get(':productionOrderId')
  @Contract('GET /planning/production-orders/{productionOrderId}')
  async detail(
    @Param('productionOrderId', ParseIntPipe) productionOrderId: number,
    @Query() query: ProductionOrderDetailQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductionOrderView> {
    const { view, versionNo } = await this.queries.detail(productionOrderId, query);
    setEtag(response, versionNo);
    return view;
  }

  /**
   * 판정 + W/O 조정. ⛔ ETag 를 안 내린다 — 계약이 200 에 선언하지 않았다. If-Match 는
   * **필수**라 가드가 이미 막았다. 200 본문은 상세 뷰라 확인 3칸이 방금 쓴 값으로 나온다.
   */
  @Post(':productionOrderId\\:acknowledge')
  @Contract('POST /planning/production-orders/{productionOrderId}:acknowledge')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @Req() request: Request,
    @Param('productionOrderId', ParseIntPipe) productionOrderId: number,
    @Body() body: ProductionOrderAcknowledge,
  ): Promise<ProductionOrderView> {
    const version = versionOf(request);
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => {
      await this.acknowledges.acknowledge(productionOrderId, version, body, appUserId);
      return (await this.queries.detail(productionOrderId, {})).view;
    }, FAMILY_CONFLICT_CODE);
  }

  /** 수신 때 못 세웠거나 확정하지 못한 계획을 다시 시도한다 — 기준정보·계획 라인을 고친 뒤. */
  @Post(':productionOrderId\\:auto-plan')
  @Contract('POST /planning/production-orders/{productionOrderId}:auto-plan')
  @HttpCode(HttpStatus.OK)
  async autoPlan(
    @Req() request: Request,
    @Param('productionOrderId', ParseIntPipe) productionOrderId: number,
  ): Promise<AutoPlanResult> {
    // 일은 멱등 트랜잭션 «밖»에서 한다(등록과 같은 까닭). 다시 해도 지금 상태로 다시 판정할 뿐이라 멱등 기록은 응답만 남긴다.
    const result = await this.autoPlans.run(productionOrderId, currentSession(request)?.userId);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => Promise.resolve(result), FAMILY_CONFLICT_CODE);
  }

  /** ⭐ 202 에 본문이 없다 — 계약이 content 를 주지 않았다. 결과는 연계 수신으로 온다. */
  @Post(':productionOrderId\\:resync')
  @Contract('POST /planning/production-orders/{productionOrderId}:resync')
  @HttpCode(HttpStatus.ACCEPTED)
  async resync(
    @Req() request: Request,
    @Param('productionOrderId', ParseIntPipe) productionOrderId: number,
  ): Promise<void> {
    await runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, async () => {
      // 멱등키가 `message_key` 의 뒷자리다 — 가드가 형식을 이미 강제했다(§5-6 · R-11).
      await this.resyncs.resync(productionOrderId, String(request.headers['idempotency-key']));
      return undefined;
    });
  }
}

/** If-Match 가 필수라 가드가 이미 막았다 — 여기 오면 값이 있다(형제 선례). */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  return version;
}

/** `ck_production_order_ack_decision` 이 `acknowledged_by` 를 함께 요구한다 — 세션이 반드시 필요하다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
