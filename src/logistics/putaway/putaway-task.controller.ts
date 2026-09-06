import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PutawayTaskQuery, PutawayTaskService } from './putaway-task.service';

/** 적치 지시 조회 2건. 화면은 `M-01-05`·`M-01-07`. 완료·임시 적재 두 POST 는 PR ② 몫이다. */
@Controller('logistics/putaway-tasks')
export class PutawayTaskController {
  constructor(private readonly tasks: PutawayTaskService) {}

  @Get()
  @Contract('GET /logistics/putaway-tasks')
  list(@Query() query: PutawayTaskQuery): Promise<PagedResponse<unknown>> {
    return this.tasks.list(query);
  }

  @Get(':putawayTaskId')
  @Contract('GET /logistics/putaway-tasks/{putawayTaskId}')
  async get(
    @Param('putawayTaskId', ParseIntPipe) putawayTaskId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { view, versionNo } = await this.tasks.get(putawayTaskId);
    setEtag(response, versionNo);
    return view;
  }
}
