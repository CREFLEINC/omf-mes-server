import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { ProductLotSplitQueryService } from './product-lot-split-query.service';
import { ProductLotSplitLookup, requireTerminal } from './product-lot-split-view';

/**
 * 생산 LOT 수량 분리(피처 013 · omf-all-around#303) — POP P-04-08 스캔 조회·분리·확인 대기 목록.
 * ⛔ 단말 전용이다(관리웹 화면이 없다). 409 봉투가 계열(`ShipmentConflictResponse`)이라 `FAMILY_CONFLICT_CODE` 를 넘긴다.
 */
@Controller('logistics')
export class ProductLotSplitController {
  constructor(private readonly queries: ProductLotSplitQueryService) {}

  @Get('product-lot-splits\\:lookup')
  @Contract('GET /logistics/product-lot-splits:lookup')
  lookup(@Req() request: Request, @Query('lotNo') lotNo: string | undefined): Promise<ProductLotSplitLookup> {
    return this.queries.lookup(lotNo, requireTerminal(request));
  }
}
