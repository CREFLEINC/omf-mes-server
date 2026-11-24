import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { TraceLotPage, TraceLotQuery, TraceLotsService } from './trace-lots.service';

/**
 * 자재 기준 생산 추적(W-02-13)·제품 기준 역추적(W-02-14) — 피처 015 · omf-all-around#355. 관리웹 세션 전용이다.
 * 목록 둘·번호 풀기·계보 둘·내보내기 둘(contracts §1~§5).
 */
@Controller('trace')
export class TraceTreeController {
  constructor(private readonly lots: TraceLotsService) {}

  @Get('material-trace-lots')
  @Contract('GET /trace/material-trace-lots')
  materialLots(@Query() query: TraceLotQuery): Promise<TraceLotPage> {
    return this.lots.materials(query);
  }

  @Get('product-trace-lots')
  @Contract('GET /trace/product-trace-lots')
  productLots(@Query() query: TraceLotQuery): Promise<TraceLotPage> {
    return this.lots.products(query);
  }
}
