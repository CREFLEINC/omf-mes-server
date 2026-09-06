import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { PickingOrderQuery, PickingQueryService } from './picking-query.service';
import { PickingOrderDetail, PickingOrderView } from './picking-view';

/**
 * 피킹 지시 조회 2건. 화면 `M-01-08`(자재 출고 피킹).
 * ⛔ ETag 를 안 내린다 — 계약이 이 둘에 응답 헤더를 선언하지 않는다(I-8.md §1-1 · §9-2).
 * 403 도 미선언이라 권한 표를 손대지 않는다 — 목록의 `M-01-08` 은 도출표가 이미 갖고 있고
 * 가드는 계약이 403 을 선언한 자리에서만 본다(`permission.guard.ts`).
 */
@Controller('logistics/picking-orders')
export class PickingController {
  constructor(private readonly queries: PickingQueryService) {}

  @Get()
  @Contract('GET /logistics/picking-orders')
  list(@Query() query: PickingOrderQuery): Promise<PagedResponse<PickingOrderView>> {
    return this.queries.list(query);
  }

  @Get(':pickingOrderId')
  @Contract('GET /logistics/picking-orders/{pickingOrderId}')
  get(
    @Param('pickingOrderId', ParseIntPipe) pickingOrderId: number,
  ): Promise<PickingOrderDetail> {
    return this.queries.get(pickingOrderId);
  }
}
