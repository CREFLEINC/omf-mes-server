import { Body, Controller, Get, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import {
  PrecheckDecisionListQuery,
  PrecheckDecisionQueryService,
} from './precheck-decision-query.service';
import { PrecheckDecisionCreate, PrecheckDecisionService } from './precheck-decision.service';
import { PrecheckDecisionView } from './precheck-decision-view';

/**
 * 작업 전 점검 통제 판정 조회 1건(I-11 PR ①) + 기록 `POST`(PR ⑤).
 * ⛔ ETag 를 계약이 선언하지 않았다(I-11 §7-1 6 · §8) — `setEtag` 를 부르지 않는다.
 */
@Controller('production/precheck-decisions')
export class PrecheckDecisionController {
  constructor(
    private readonly queries: PrecheckDecisionQueryService,
    private readonly decisions: PrecheckDecisionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /production/precheck-decisions')
  list(@Query() query: PrecheckDecisionListQuery): Promise<PagedResponse<PrecheckDecisionView>> {
    return this.queries.list(query);
  }

  /**
   * 통제 판정 기록. ⛔ 헤더는 계약 검증 가드가 안 본다 — 사번 필수 판정은 서비스 몫이다
   * (`production-result.controller.ts` 와 같은 가름).
   */
  @Post()
  @Contract('POST /production/precheck-decisions')
  create(@Req() request: Request, @Body() body: PrecheckDecisionCreate): Promise<PrecheckDecisionView> {
    const workerNo = request.headers['x-worker-no'];
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      appUserId: currentSession(request)?.userId,
    };
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.decisions.create(body, context));
  }
}
