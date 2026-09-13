import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { PagedResponse } from '../../common/pagination';
import { DefectDistributionQuery, DefectDistributionService } from './defect-distribution.service';
import { DefectRecordListQuery, DefectRecordService } from './defect-record.service';
import { DefectRecordView } from './defect-view';

/**
 * 불량 실적 조회 2건(I-20 PR ①b). ⛔ 등록 경로 0줄 — 계약이 직접 적었다(`x-internal-note`).
 * ⛔ 조회 2건은 계약이 403 을 선언하지 않았다(`permission.guard.ts:37-41`) — 권한 등록 0줄.
 * ⛔ 멱등·If-Match·ETag 0 — 계약 미선언.
 */
@Controller('quality/defect-records')
export class DefectRecordController {
  constructor(
    private readonly records: DefectRecordService,
    private readonly distributions: DefectDistributionService,
  ) {}

  @Get()
  @Contract('GET /quality/defect-records')
  list(@Req() request: Request, @Query() query: DefectRecordListQuery): Promise<PagedResponse<DefectRecordView>> {
    return this.records.list(query, currentTerminalQualityReadScope(request));
  }

  @Get('distribution')
  @Contract('GET /quality/defect-records/distribution')
  distribution(@Query() query: DefectDistributionQuery) {
    return this.distributions.distribution(query);
  }
}
