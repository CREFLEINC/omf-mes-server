import { logisticsWriteActorOf } from '../logistics-write-actor';
import { Body, Controller, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { RecycleEntryView } from './recycle-entry-view';
import { RecycleEntryContext, RecycleEntryService } from './recycle-entry.service';
import { RecycleEntryCreate } from './recycle-posting';

/** 재생재 등록 1 오퍼레이션(화면 `M-01-12`). 계약에 조회가 0건이라 GET 이 없다. */
@Controller('logistics/recycle-entries')
export class RecycleEntryController {
  constructor(
    private readonly entries: RecycleEntryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * ⛔ **If-Match 를 안 받는다** — 새 자원이라 대조할 버전이 없다(C-9 · `handling-unit.controller.ts:79`
   * 의 같은 판정). 가드는 `optional` 이라 헤더가 없으면 통과하고 있으면 기억만 해 무해하다.
   * ⛔ **`setEtag` 를 부르지 않는다** — 계약 `responses['201'].headers` 가 «없다»(§1-1).
   */
  @Post()
  @Contract('POST /logistics/recycle-entries')
  create(@Req() request: Request, @Body() body: RecycleEntryCreate): Promise<RecycleEntryView> {
    const context = contextOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.entries.create(body, context),
    );
  }
}

function contextOf(request: Request): RecycleEntryContext {
  const workerNo = request.header('X-Worker-No');
  return { workerNo: typeof workerNo === 'string' ? workerNo : undefined,
    actor: logisticsWriteActorOf(request, 'POST /logistics/recycle-entries') };
}
