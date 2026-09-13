import { currentTerminal } from '../../auth/terminal-context';
import {
  Body,
  Controller,
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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  PurchaseOrderQuery,
  PurchaseOrderQueryService,
} from './purchase-order-query.service';
import { PurchaseOrderDetail, PurchaseOrderLineView, PurchaseOrderView } from './purchase-order-view';
import {
  PurchaseOrderCreateInput,
  PurchaseOrderLineWriteInput,
  PurchaseOrderService,
  PurchaseOrderUpdateInput,
} from './purchase-order.service';

/** P/O 7 오퍼레이션 전건 — 조회 3 + 쓰기 4. 화면 `W-01-09`(목록)·`W-01-03`·`W-01-11`(상세·등록·수정·상신). */
@Controller('logistics/purchase-orders')
export class PurchaseOrderController {
  constructor(
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly queries: PurchaseOrderQueryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/purchase-orders')
  list(@Req() request: Request, @Query() query: PurchaseOrderQuery): Promise<PagedResponse<PurchaseOrderView>> {
    return this.queries.list(plantQuery(query, request));
  }

  @Get(':purchaseOrderId')
  @Contract('GET /logistics/purchase-orders/{purchaseOrderId}')
  async get(
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PurchaseOrderDetail> {
    const { detail, versionNo } = await this.queries.get(purchaseOrderId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':purchaseOrderId/lines')
  @Contract('GET /logistics/purchase-orders/{purchaseOrderId}/lines')
  async lines(
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
  ): Promise<{ items: PurchaseOrderLineView[] }> {
    return { items: await this.queries.lines(purchaseOrderId) };
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

  @Put(':purchaseOrderId/lines')
  @Contract('PUT /logistics/purchase-orders/{purchaseOrderId}/lines')
  async replaceLines(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
    @Body() body: { items: PurchaseOrderLineWriteInput[] },
  ): Promise<{ items: PurchaseOrderLineView[] }> {
    const appUserId = userOf(request);
    const items = await runVersioned<PurchaseOrderLineView[], 'items'>(
      this.idempotency,
      request,
      response,
      'items',
      (version) => this.purchaseOrders.replaceLines(purchaseOrderId, version, body.items, appUserId),
    );
    return { items };
  }

  @Post(':purchaseOrderId\\:request-approval')
  @Contract('POST /logistics/purchase-orders/{purchaseOrderId}:request-approval')
  @HttpCode(HttpStatus.ACCEPTED)
  requestApproval(
    @Req() request: Request,
    @Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number,
    @Body() body: { reason: string },
  ): Promise<{ approvalRequestId: number }> {
    // ⛔ `runVersioned` 를 못 쓴다 — 202 에 ETag 가 없어 새 토큰을 내릴 자리가 없다. 대신
    //    가드가 파싱해 둔 If-Match 값을 직접 꺼내 서비스가 «비교만» 한다(I-2.md §6-2·§6-3).
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, () =>
      this.purchaseOrders.requestApproval(purchaseOrderId, version, body.reason, appUserId),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}

function plantQuery<T extends { plantId?: number }>(query: T, request: Request): T {
  const plantId = currentTerminal(request)?.plantId;
  return plantId === undefined ? query : { ...query, plantId: Number(plantId) };
}
