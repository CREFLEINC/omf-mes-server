import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  InventoryTransactionService,
  TransactionDetail,
  TransactionQuery,
} from './inventory-transaction.service';

/**
 * 수불 이력. 화면은 `W-01-07`(재고 현황·상태 조회)이 목록을, `W-01-13`(물류 문서 진행
 * 현황)이 상세를 쓴다.
 */
@Controller('inventory/transactions')
export class InventoryTransactionController {
  constructor(private readonly transactions: InventoryTransactionService) {}

  @Get()
  @Contract('GET /inventory/transactions')
  list(@Query() query: TransactionQuery): Promise<PagedResponse<unknown>> {
    return this.transactions.list(query);
  }

  /**
   * ⛔ 경로에 식별자가 «둘» 온다 — 영업일이 파티션 키라 id 만으로는 행을 찾을 수 없다.
   * 복합 키를 URL 에 그대로 드러낸 유일한 자리다(계약 `x-internal-note`).
   */
  @Get(':businessDate/:inventoryTransactionId')
  @Contract('GET /inventory/transactions/{businessDate}/{inventoryTransactionId}')
  get(
    @Param('businessDate') businessDate: string,
    @Param('inventoryTransactionId', ParseIntPipe) inventoryTransactionId: number,
  ): Promise<TransactionDetail> {
    return this.transactions.get(businessDate, inventoryTransactionId);
  }
}
