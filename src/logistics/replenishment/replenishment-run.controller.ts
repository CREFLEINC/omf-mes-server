import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { ReplenishmentRunQuery, ReplenishmentRunService } from './replenishment-run.service';

/** 생산 창고 보충 — 자동 보충 실행 기록(W-02-12 · 피처 004). */
@Controller('logistics/replenishment-runs')
export class ReplenishmentRunController {
  constructor(private readonly runs: ReplenishmentRunService) {}

  @Get()
  @Contract('GET /logistics/replenishment-runs')
  list(@Query() query: ReplenishmentRunQuery): Promise<PagedResponse<unknown>> {
    return this.runs.list(query);
  }
}
