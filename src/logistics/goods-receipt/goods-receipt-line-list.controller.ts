import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedWithTotals } from '../line-list';
import {
  GoodsReceiptLineListItem,
  GoodsReceiptLineListQuery,
  GoodsReceiptLineListService,
} from './goods-receipt-line-list.service';

/** 자재입고·생산입고 현황 — 입하~출고 추적 화면(장부 P-119). 관리웹 세션 전용이다. */
@Controller('logistics/goods-receipt-lines')
export class GoodsReceiptLineListController {
  constructor(private readonly lines: GoodsReceiptLineListService) {}

  @Get()
  @Contract('GET /logistics/goods-receipt-lines')
  list(@Query() query: GoodsReceiptLineListQuery): Promise<PagedWithTotals<GoodsReceiptLineListItem>> {
    return this.lines.list(query);
  }
}
