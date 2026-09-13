import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { mobileProductionWriteActorOf } from '../mobile-production-write-actor';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import {
  OperationHandoverListQuery,
  OperationHandoverQueryService,
} from './operation-handover-query.service';
import { OperationHandoverView } from './operation-handover-view';
import { OperationHandoverCreate, OperationHandoverService } from './operation-handover.service';

/**
 * 공정 인계 조회 2건(I-25 PR ①) + 확정 등록 1건(PR ②). 403 을 선언하는 것은 등록 하나이고
 * 그 권한(`M-02-01`)은 `derived-permissions.ts:230` 에 **이미 있다** — 권한 표를 손대지 않는다.
 * ⛔ 셋 다 계약이 ETag 를 선언하지 않았다 — `setEtag`·`runVersioned` 를 부르지 않는다.
 */
@Controller('production/operation-handovers')
export class OperationHandoverController {
  constructor(
    private readonly queries: OperationHandoverQueryService,
    private readonly handovers: OperationHandoverService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  /**
   * 확정 등록. ⛔ **`If-Match` 는 「선택」이라 받되 버린다** — 신규 생성이라 대조할 `version_no`
   * 가 아직 없다(계약이 그 이유를 직접 적었다). `runVersioned` 는 토큰이 없으면 던져 500 이
   * 되므로 **못 쓴다**(`material-return.controller.ts` 와 같은 자리). 400 도 내지 않는다.
   * `X-Worker-No` 는 계약 검증 가드가 안 보는 헤더라 서비스가 손으로 본다.
   */
  @Post()
  @Contract('POST /production/operation-handovers')
  create(@Req() request: Request, @Body() body: OperationHandoverCreate): Promise<OperationHandoverView> {
    const actor = mobileProductionWriteActorOf(request, 'POST /production/operation-handovers');
    const workerNo = request.headers['x-worker-no'];
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.handovers.create(body, actor, typeof workerNo === 'string' ? workerNo : undefined),
      FAMILY_CONFLICT_CODE,
    );
  }
}
