import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { SalesOrderQuery, SalesOrderQueryService } from './sales-order-query.service';
import { SalesOrderView } from './sales-order-view';

/**
 * 고객사 출하지시서 조회 2건 — 화면 `W-04-01`.
 *
 * ⛔ 쓰기 경로를 두지 않는다 — 원천이 ERP 연계와 엑셀 import 둘이고 MES 는 받기만 한다
 * (계약 `SalesOrder.description`). 그래서 멱등 키·If-Match·ETag·403 이 전부 없다.
 */
@Controller('logistics/sales-orders')
export class SalesOrderController {
  constructor(private readonly queries: SalesOrderQueryService) {}

  @Get()
  @Contract('GET /logistics/sales-orders')
  list(@Query() query: SalesOrderQuery): Promise<PagedResponse<SalesOrderView>> {
    return this.queries.list(query);
  }

  @Get(':salesOrderId')
  @Contract('GET /logistics/sales-orders/{salesOrderId}')
  get(@Param('salesOrderId', ParseIntPipe) salesOrderId: number): Promise<SalesOrderView> {
    return this.queries.get(salesOrderId);
  }
}
