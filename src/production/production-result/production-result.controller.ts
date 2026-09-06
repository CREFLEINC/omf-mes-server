import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import { ProductionResultListQuery, ProductionResultQueryService } from './production-result-query.service';
import { ProductionResultView } from './production-result-view';

/**
 * 생산 실적 조회 — 목록·단건(I-7 PR ①). 질의의 형·기본값은 계약 검증 가드(`@Contract`)가
 * 이미 맞췄다 — 여기서 다시 검사하지 않는다.
 * ⛔ 권한 가드가 보지 않는다 — 계약이 이 둘에 403 을 선언하지 않았다(§8-1 · 추가 0건).
 * ⛔ `setEtag` 를 부르지 않는다 — 계약이 200 에 ETag 를 선언한 것이 I-7 7건 중 0건이다.
 */
@Controller('production/production-results')
export class ProductionResultController {
  constructor(private readonly queries: ProductionResultQueryService) {}

  @Get()
  @Contract('GET /production/production-results')
  list(@Query() query: ProductionResultListQuery): Promise<PagedResponse<ProductionResultView>> {
    return this.queries.list(query);
  }

  @Get(':productionResultId')
  @Contract('GET /production/production-results/{productionResultId}')
  detail(@Param('productionResultId', ParseIntPipe) productionResultId: number): Promise<ProductionResultView> {
    return this.queries.detail(productionResultId);
  }
}
