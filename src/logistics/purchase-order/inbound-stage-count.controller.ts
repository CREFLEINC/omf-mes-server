import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { InboundStageGroup } from './inbound-stage';
import { parseOrderListExtras } from './purchase-order-line-list';
import { PurchaseOrderQuery, PurchaseOrderQueryService } from './purchase-order-query.service';
import { plantQuery } from './purchase-order.controller';

/**
 * 입고 관리 허브의 단계 칩 「검사 대기 N · 보류 N · 입고 대기 N · 적치 대기 N」(장부 P-110).
 * ⛔ 컬렉션에 붙는 액션은 컨트롤러 접두어를 «짧게» 잡는다 — `inbound-receipts:split` 과 같은 이유다.
 */
@Controller('logistics')
export class InboundStageCountController {
  constructor(private readonly queries: PurchaseOrderQueryService) {}

  @Get('purchase-orders\\:inbound-stage-counts')
  @Contract('GET /logistics/purchase-orders:inbound-stage-counts')
  async counts(
    @Req() request: Request,
    @Query() query: PurchaseOrderQuery,
  ): Promise<{ counts: Record<InboundStageGroup, number> }> {
    // 목록과 같은 조건 — 계약 밖 조건(장부 P-85)도 목록처럼 여기서 검사한다.
    const extras = parseOrderListExtras(query as unknown as Record<string, unknown>);
    return { counts: await this.queries.inboundStageCounts(plantQuery({ ...query, ...extras }, request)) };
  }
}
