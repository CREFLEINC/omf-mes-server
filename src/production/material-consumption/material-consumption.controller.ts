import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import {
  MaterialConsumptionListQuery,
  MaterialConsumptionQueryService,
} from './material-consumption-query.service';
import { MaterialConsumptionView } from './material-consumption-view';
import { MaterialConsumptionCreate, MaterialConsumptionService } from './material-consumption.service';

/**
 * 자재 투입 조회 2건(I-10 PR ①) + 등록(PR ②).
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다 — 계약이 I-10 6건 어디에도
 *    응답 헤더를 선언하지 않았다(I-10 §1-1).
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — 조회 둘은 미선언이라 권한 표를
 *    손대지 않는다(`permission.guard.ts:37-41`).
 */
@Controller('production/material-consumptions')
export class MaterialConsumptionController {
  constructor(
    private readonly queries: MaterialConsumptionQueryService,
    private readonly consumptions: MaterialConsumptionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /production/material-consumptions')
  list(@Query() query: MaterialConsumptionListQuery): Promise<PagedResponse<MaterialConsumptionView>> {
    return this.queries.list(query);
  }

  @Get(':materialConsumptionId')
  @Contract('GET /production/material-consumptions/{materialConsumptionId}')
  detail(
    @Param('materialConsumptionId', ParseIntPipe) materialConsumptionId: number,
  ): Promise<MaterialConsumptionView> {
    return this.queries.detail(materialConsumptionId);
  }

  /**
   * 투입 등록. ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**이라 토큰이 없으면 저쪽이
   * 던져 500 이 된다(`master-write.ts:48-51`). 신규 생성이라 대조할 버전도 없어 **받되 버린다**.
   */
  @Post()
  @Contract('POST /production/material-consumptions')
  create(@Req() request: Request, @Body() body: MaterialConsumptionCreate): Promise<MaterialConsumptionView> {
    // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206-207`) — 사번의 필수 판정은 서비스 몫이다.
    const workerNo = request.headers['x-worker-no'];
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      idempotencyKey: String(request.headers['idempotency-key']),
      appUserId: currentSession(request)?.userId,
    };
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.consumptions.create(body, context));
  }
}
