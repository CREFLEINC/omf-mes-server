import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { AcknowledgeService, ProductionOrderAcknowledge } from './acknowledge.service';
import { ProductionOrderDetailQuery, ProductionOrderListQuery, ProductionOrderService } from './production-order.service';
import { ProductionOrderView } from './production-order-view';

/** P/O 조회 2건(PR ①) + `:acknowledge`(PR ④). */
@Controller('planning/production-orders')
export class ProductionOrderController {
  constructor(
    private readonly queries: ProductionOrderService,
    private readonly acknowledges: AcknowledgeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /planning/production-orders')
  list(@Query() query: ProductionOrderListQuery): Promise<PagedResponse<ProductionOrderView>> {
    return this.queries.list(query);
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
    });
  }
}

/** If-Match 가 필수라 가드가 이미 막았다 — 여기 오면 값이 있다(형제 선례). */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}

/** `ck_production_order_ack_decision` 이 `acknowledged_by` 를 함께 요구한다 — 세션이 반드시 필요하다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
