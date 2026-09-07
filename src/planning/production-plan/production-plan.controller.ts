import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { ProductionPlanListQuery, ProductionPlanService } from './production-plan.service';
import { ProductionPlanView } from './production-plan-view';

/** 생산계획 조회 2건(PR ①) — `POST`·`PUT`·`DELETE`·`:confirm` 은 PR ②③ 몫. */
@Controller('planning/production-plans')
export class ProductionPlanController {
  constructor(private readonly queries: ProductionPlanService) {}

  @Get()
  @Contract('GET /planning/production-plans')
  list(@Query() query: ProductionPlanListQuery): Promise<PagedResponse<ProductionPlanView>> {
    return this.queries.list(query);
  }

  @Get(':productionPlanId')
  @Contract('GET /planning/production-plans/{productionPlanId}')
  async detail(
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductionPlanView> {
    const { view, versionNo } = await this.queries.detail(productionPlanId);
    setEtag(response, versionNo);
    return view;
  }
}
