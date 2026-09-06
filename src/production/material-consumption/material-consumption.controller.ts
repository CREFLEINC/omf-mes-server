import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  MaterialConsumptionListQuery,
  MaterialConsumptionQueryService,
} from './material-consumption-query.service';
import { MaterialConsumptionView } from './material-consumption-view';

/**
 * 자재 투입 조회 2건(I-10 PR ①). 등록(`POST`)은 PR ② 몫이다.
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다 — 계약이 I-10 6건 어디에도
 *    응답 헤더를 선언하지 않았다(I-10 §1-1).
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — 조회 둘은 미선언이라 권한 표를
 *    손대지 않는다(`permission.guard.ts:37-41`).
 */
@Controller('production/material-consumptions')
export class MaterialConsumptionController {
  constructor(private readonly queries: MaterialConsumptionQueryService) {}

  @Get()
  @Contract('GET /production/material-consumptions')
  list(@Query() query: MaterialConsumptionListQuery): Promise<PagedResponse<MaterialConsumptionView>> {
    return this.queries.list(query);
  }

  @Get(':materialConsumptionId')
  @Contract('GET /production/material-consumptions/{materialConsumptionId}')
  detail(
    @Param('materialConsumptionId', ParseIntPipe) materialConsumptionId: number,
  ): Promise<MaterialConsumptionView> {
    return this.queries.detail(materialConsumptionId);
  }
}
