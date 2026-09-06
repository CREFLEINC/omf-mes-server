import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import { MaterialReturnListQuery, MaterialReturnQueryService } from './material-return-query.service';
import { MaterialReturnView } from './material-return-view';

/**
 * 자재 반출 조회 2건(I-10 PR ①). 등록(`POST`)은 PR ③ 몫이고 그 하나만 403 을 선언한다.
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다(I-10 §1-1·§6-2).
 * ⛔ 조회 둘은 403 미선언이라 권한 표를 손대지 않는다.
 */
@Controller('production/material-returns')
export class MaterialReturnController {
  constructor(private readonly queries: MaterialReturnQueryService) {}

  @Get()
  @Contract('GET /production/material-returns')
  list(@Query() query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    return this.queries.list(query);
  }

  @Get(':materialReturnId')
  @Contract('GET /production/material-returns/{materialReturnId}')
  detail(@Param('materialReturnId', ParseIntPipe) materialReturnId: number): Promise<MaterialReturnView> {
    return this.queries.detail(materialReturnId);
  }
}
