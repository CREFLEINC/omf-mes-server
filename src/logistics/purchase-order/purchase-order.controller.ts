import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PurchaseOrderDetail, PurchaseOrderLineView, PurchaseOrderView } from './purchase-order-view';
import { PurchaseOrderQuery, PurchaseOrderService } from './purchase-order.service';

/** P/O 조회 3건. 화면 `W-01-09`(목록)·`W-01-03`·`W-01-11`(상세). 쓰기 4건은 뒤 PR(§8 ④·⑤)이 연다. */
@Controller('logistics/purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly purchaseOrders: PurchaseOrderService) {}

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
}
