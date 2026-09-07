import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { ProductionOrderDetailQuery, ProductionOrderListQuery, ProductionOrderService } from './production-order.service';
import { ProductionOrderView } from './production-order-view';

/** P/O 조회 2건(PR ①) — `:acknowledge`·`:resync` 는 PR ④ 몫. */
@Controller('planning/production-orders')
export class ProductionOrderController {
  constructor(private readonly queries: ProductionOrderService) {}

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
}
