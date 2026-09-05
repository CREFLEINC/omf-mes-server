import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import {
  BalanceQuery,
  BalanceResponse,
  InventoryBalanceService,
} from './inventory-balance.service';

/** 재고 잔액. 화면은 `W-01-07`(재고 현황)·`M-01-04`(현장 조회)가 함께 쓴다. */
@Controller('inventory/balances')
export class InventoryBalanceController {
  constructor(private readonly balances: InventoryBalanceService) {}

  @Get()
  @Contract('GET /inventory/balances')
  list(@Query() query: BalanceQuery): Promise<BalanceResponse> {
    return this.balances.list(query);
  }
}
