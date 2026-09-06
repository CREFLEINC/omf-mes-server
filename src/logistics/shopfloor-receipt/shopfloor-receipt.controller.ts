import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  ShopfloorReceiptQuery,
  ShopfloorReceiptQueryService,
} from './shopfloor-receipt-query.service';
import { ShopfloorReceiptDetail, ShopfloorReceiptView } from './shopfloor-receipt-view';

/**
 * 생산창고 입고 조회 2건. 소유 화면 `P-02-03`(I-9.md R-12).
 * ⛔ ETag 를 안 내린다 — 계약이 이 둘에 응답 헤더를 선언하지 않는다(I-9.md §1-1).
 * 403 도 미선언이라 권한 표를 손대지 않는다 — `derived-permissions.ts:70·71` 에 이미
 * `P-02-03` 이 등재돼 있으나 가드는 계약이 403 을 선언한 자리에서만 본다.
 */
@Controller('logistics/shopfloor-receipts')
export class ShopfloorReceiptController {
  constructor(private readonly queries: ShopfloorReceiptQueryService) {}

  @Get()
  @Contract('GET /logistics/shopfloor-receipts')
  list(@Query() query: ShopfloorReceiptQuery): Promise<PagedResponse<ShopfloorReceiptView>> {
    return this.queries.list(query);
  }

  @Get(':shopfloorReceiptId')
  @Contract('GET /logistics/shopfloor-receipts/{shopfloorReceiptId}')
  get(
    @Param('shopfloorReceiptId', ParseIntPipe) shopfloorReceiptId: number,
  ): Promise<ShopfloorReceiptDetail> {
    return this.queries.get(shopfloorReceiptId);
  }
}
