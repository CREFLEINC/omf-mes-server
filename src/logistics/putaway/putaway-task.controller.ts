import { logisticsWriteActorOf } from '../logistics-write-actor';
import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PutawayCompleteContext, PutawayCompleteService, PutawayTaskComplete } from './putaway-complete.service';
import { PutawayTaskView } from './putaway-task-view';
import { PutawayTaskQuery, PutawayTaskService } from './putaway-task.service';

/** 적치 지시 조회 2 + 완료·임시 적재 2. 화면은 `M-01-05`·`M-01-07`. */
@Controller('logistics/putaway-tasks')
export class PutawayTaskController {
  constructor(
    private readonly tasks: PutawayTaskService,
    private readonly completes: PutawayCompleteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/putaway-tasks')
  list(@Req() request: Request, @Query() query: PutawayTaskQuery): Promise<PagedResponse<unknown>> {
    return this.tasks.list(query, currentTerminal(request)?.plantId);
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

  /**
   * ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**이라 토큰이 없으면 저쪽이 던져 500 이
   * 된다(피킹 `:pick` 과 같은 가름). ⛔ `setEtag` 도 안 부른다 — 계약 미선언이다.
   */
  @Post(':putawayTaskId\\:complete')
  @Contract('POST /logistics/putaway-tasks/{putawayTaskId}:complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Req() request: Request, @Param('putawayTaskId', ParseIntPipe) putawayTaskId: number,
    @Body() body: PutawayTaskComplete,
  ): Promise<PutawayTaskView> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.completes.complete(putawayTaskId, body,
        contextOf(request, 'POST /logistics/putaway-tasks/{putawayTaskId}:complete'), 'NORMAL'),
    );
  }

  /** 정상 적치와 «상태»만 갈린다 — 권장 강제의 탈출구라 같은 자물쇠를 걸지 않는다. */
  @Post(':putawayTaskId\\:complete-temporary')
  @Contract('POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary')
  @HttpCode(HttpStatus.OK)
  completeTemporary(
    @Req() request: Request, @Param('putawayTaskId', ParseIntPipe) putawayTaskId: number,
    @Body() body: PutawayTaskComplete,
  ): Promise<PutawayTaskView> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.completes.complete(putawayTaskId, body,
        contextOf(request, 'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary'), 'TEMPORARY'),
    );
  }
}

/** 헤더는 계약 검증 가드가 안 본다 — 사번 필수 판정은 서비스 몫이다(피킹 선례). */
function contextOf(request: Request, operationKey: string): PutawayCompleteContext {
  const workerNo = request.headers['x-worker-no'];
  return {
    workerNo: typeof workerNo === 'string' ? workerNo : undefined,
    version: ifMatchVersion(request),
    actor: logisticsWriteActorOf(request, operationKey),
  };
}
