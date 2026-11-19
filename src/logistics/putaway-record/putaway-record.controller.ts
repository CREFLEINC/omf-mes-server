import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { PutawayRecordView } from './putaway-record.query';
import { PutawayRecordQuery, PutawayRecordService } from './putaway-record.service';

/** PDA 적치 기록(피처 011 · omf-all-around#325) — 화면 M-01-14. MOBILE 단말 전용. */
@Controller('logistics/putaway-records')
export class PutawayRecordController {
  constructor(private readonly records: PutawayRecordService) {}

  @Get()
  @Contract('GET /logistics/putaway-records')
  list(@Req() request: Request, @Query() query: PutawayRecordQuery): Promise<PagedResponse<PutawayRecordView>> {
    return this.records.list(request, query);
  }
}
