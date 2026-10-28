import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { BackwardFlow, ForwardFlow, LotFlowChainService } from './lot-flow-chain.service';
import { MaterialLotFlowList, MaterialLotFlowListService, MaterialLotFlowQuery } from './material-lot-flow-list.service';
import { ProductLotFlowList, ProductLotFlowListService, ProductLotFlowQuery } from './product-lot-flow-list.service';

/** LOT 생산 이력 조회 화면(W-02-09)의 정방향·역방향 — 목록과 LOT 하나의 사슬(장부 P-119). 관리웹 세션 전용이다. */
@Controller('trace')
export class LotFlowController {
  constructor(
    private readonly materials: MaterialLotFlowListService,
    private readonly products: ProductLotFlowListService,
    private readonly chains: LotFlowChainService,
  ) {}

  @Get('material-lot-flows')
  @Contract('GET /trace/material-lot-flows')
  materialLots(@Query() query: MaterialLotFlowQuery): Promise<MaterialLotFlowList> {
    return this.materials.list(query);
  }

  @Get('product-lot-flows')
  @Contract('GET /trace/product-lot-flows')
  productLots(@Query() query: ProductLotFlowQuery): Promise<ProductLotFlowList> {
    return this.products.list(query);
  }

  @Get('lots/:lotId/forward-flow')
  @Contract('GET /trace/lots/{lotId}/forward-flow')
  forward(@Param('lotId', ParseIntPipe) lotId: number): Promise<ForwardFlow> {
    return this.chains.forward(lotId);
  }

  @Get('lots/:lotId/backward-flow')
  @Contract('GET /trace/lots/{lotId}/backward-flow')
  backward(@Param('lotId', ParseIntPipe) lotId: number): Promise<BackwardFlow> {
    return this.chains.backward(lotId);
  }
}
