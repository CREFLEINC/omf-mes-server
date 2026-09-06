import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  PrecheckDecisionListQuery,
  PrecheckDecisionQueryService,
} from './precheck-decision-query.service';
import { PrecheckDecisionView } from './precheck-decision-view';

/**
 * 작업 전 점검 통제 판정 조회 1건(I-11 PR ①). 등록(`POST`)은 PR ⑤ 몫이다.
 * ⛔ ETag·403 을 계약이 선언하지 않았다(I-11 §8) — 권한 표를 손대지 않는다.
 */
@Controller('production/precheck-decisions')
export class PrecheckDecisionController {
  constructor(private readonly queries: PrecheckDecisionQueryService) {}

  @Get()
  @Contract('GET /production/precheck-decisions')
  list(@Query() query: PrecheckDecisionListQuery): Promise<PagedResponse<PrecheckDecisionView>> {
    return this.queries.list(query);
  }
}
