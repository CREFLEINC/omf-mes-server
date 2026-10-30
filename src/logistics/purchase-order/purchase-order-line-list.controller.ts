import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { LineListContractQuery, PurchaseOrderLineListItem, parseLineListQuery } from './purchase-order-line-list';
import { PurchaseOrderLineListService } from './purchase-order-line-list.service';

/**
 * 입하 예정 — 구매발주 라인 목록(장부 P-78 · #741). 화면은 관리웹 W-01-09.
 * 화면 권한은 보지 않는다 — 계약에 403 이 없어 로그인만 본다(같은 화면의 발주 목록과 같다). 단말 범위 표에 없어 단말 토큰은 401 이다.
 */
@Controller('logistics/purchase-order-lines')
export class PurchaseOrderLineListController {
  constructor(private readonly lines: PurchaseOrderLineListService) {}

  @Get()
  @Contract('GET /logistics/purchase-order-lines')
  list(@Query() query: LineListContractQuery): Promise<PagedResponse<PurchaseOrderLineListItem>> {
    return this.lines.list(parseLineListQuery(query));
  }
}
