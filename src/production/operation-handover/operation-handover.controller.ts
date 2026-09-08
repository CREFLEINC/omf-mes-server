import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  OperationHandoverListQuery,
  OperationHandoverQueryService,
} from './operation-handover-query.service';
import { OperationHandoverView } from './operation-handover-view';

/**
 * 공정 인계 조회 2건(I-25 PR ①). 확정 등록(`POST`, PR ②)은 이 컨트롤러에 뒤이어 더한다.
 * ⛔ 조회 둘은 403·ETag 를 계약이 선언하지 않았다 — `setEtag`·`runVersioned` 를 부르지 않고
 *    권한 표도 손대지 않는다.
 */
@Controller('production/operation-handovers')
export class OperationHandoverController {
  constructor(private readonly queries: OperationHandoverQueryService) {}

  @Get()
  @Contract('GET /production/operation-handovers')
  list(@Query() query: OperationHandoverListQuery): Promise<PagedResponse<OperationHandoverView>> {
    return this.queries.list(query);
  }

  @Get(':operationHandoverId')
  @Contract('GET /production/operation-handovers/{operationHandoverId}')
  detail(
    @Param('operationHandoverId', ParseIntPipe) operationHandoverId: number,
  ): Promise<OperationHandoverView> {
    return this.queries.detail(operationHandoverId);
  }
}
