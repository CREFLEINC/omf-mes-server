import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  PurchaseOrderLineQuery,
  PurchaseOrderLineQueryService,
} from './purchase-order-line-query.service';
import { PurchaseOrderLineSchedule } from './purchase-order-line-schedule';
import { plantQuery } from './purchase-order.controller';

/** 입하 예정 — P/O 라인 목록 1건(장부 P-77). 화면 `W-01-09`. 조회 전용. */
@Controller('logistics/purchase-order-lines')
export class PurchaseOrderLineController {
  constructor(private readonly queries: PurchaseOrderLineQueryService) {}

  @Get()
  @Contract('GET /logistics/purchase-order-lines')
  list(
    @Req() request: Request,
    @Query() query: PurchaseOrderLineQuery,
  ): Promise<PagedResponse<PurchaseOrderLineSchedule>> {
    // 단말 세션이면 그 단말의 공장으로 좁힌다 — P/O 목록과 같다.
    return this.queries.list(plantQuery(query, request));
  }
}
