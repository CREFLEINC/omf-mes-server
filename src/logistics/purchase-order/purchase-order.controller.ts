import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PurchaseOrderDetail, PurchaseOrderLineView, PurchaseOrderView } from './purchase-order-view';
import {
  PurchaseOrderCreateInput,
  PurchaseOrderQuery,
  PurchaseOrderService,
  PurchaseOrderUpdateInput,
} from './purchase-order.service';

/** P/O 조회 3건 + 등록·헤더 수정. 화면 `W-01-09`(목록)·`W-01-03`·`W-01-11`(상세·등록·수정). 라인 치환·상신은 뒤 PR(§8 ⑤)이 연다. */
@Controller('logistics/purchase-orders')
export class PurchaseOrderController {
  constructor(
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/purchase-orders')
  list(@Query() query: PurchaseOrderQuery): Promise<PagedResponse<PurchaseOrderView>> {
    return this.purchaseOrders.list(query);
  }

  @Get(':purchaseOrderId')
  @Contract('GET /logistics/purchase-orders/{purchaseOrderId}')
  async get(
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PurchaseOrderDetail> {
    const { detail, versionNo } = await this.purchaseOrders.get(purchaseOrderId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':purchaseOrderId/lines')
  @Contract('GET /logistics/purchase-orders/{purchaseOrderId}/lines')
  async lines(
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
  ): Promise<{ items: PurchaseOrderLineView[] }> {
    return { items: await this.purchaseOrders.lines(purchaseOrderId) };
  }

  @Post()
  @Contract('POST /logistics/purchase-orders')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: PurchaseOrderCreateInput,
  ): Promise<PurchaseOrderDetail> {
    // 이 저장소 최초 「201 + ETag」 모양을 재사용한다 — `work()` 가 `{versionNo, detail}` 을
    // 돌려주고 컨트롤러가 ETag 를 건다(I-1.md R-6 · approval-route.controller.ts 선례).
    const appUserId = userOf(request);
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.purchaseOrders.create(body, appUserId),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }

  @Put(':purchaseOrderId')
  @Contract('PUT /logistics/purchase-orders/{purchaseOrderId}')
  async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
    @Body() body: PurchaseOrderUpdateInput,
  ): Promise<PurchaseOrderView> {
    const appUserId = userOf(request);
    return runVersioned<PurchaseOrderView, 'purchaseOrder'>(
      this.idempotency,
      request,
      response,
      'purchaseOrder',
      (version) => this.purchaseOrders.update(purchaseOrderId, version, body, appUserId),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
