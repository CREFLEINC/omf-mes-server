import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  RepairExecutionListQuery,
  RepairExecutionQueryService,
} from './repair-execution-query.service';
import { RepairExecutionView } from './repair-execution-view';

/**
 * 수리 실행 목록 조회 1건(I-25 PR ①). 투입·반출(`POST` 둘, PR ③)은 이 컨트롤러에 뒤이어 더한다.
 * ⛔ 목록은 403 을 계약이 선언하지 않았다 — 권한 표를 손대지 않는다(§6-3).
 */
@Controller('production/repair-executions')
export class RepairExecutionController {
  constructor(private readonly queries: RepairExecutionQueryService) {}

  @Get()
  @Contract('GET /production/repair-executions')
  list(@Query() query: RepairExecutionListQuery): Promise<PagedResponse<RepairExecutionView>> {
    return this.queries.list(query);
  }
}
