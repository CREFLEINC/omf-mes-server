import {
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

import { Contract } from '../../common/contract';
import { ConflictException } from '../../common/errors';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import {
  OperationHandoverListQuery,
  OperationHandoverQueryService,
} from './operation-handover-query.service';
import { OperationHandoverView } from './operation-handover-view';

/** 공정 인계는 반제품 투입으로 바뀌었다(피처 016 R-7) — 옛 단말이 계보 없는 인계를 다시 쌓지 않게 새 기록을 받지 않는다. */
export const HANDOVER_RETIRED = 'HANDOVER_RETIRED';

/**
 * 공정 인계 조회 2건(I-25 PR ①) + 확정 등록 1건(PR ② · 피처 016 부터 409 로 닫음 — 지난 기록 조회는 그대로). 403 을 선언하는 것은 등록 하나이고
 * 그 권한(`M-02-01`)은 `derived-permissions.ts:230` 에 **이미 있다** — 권한 표를 손대지 않는다(피처 016 에서 등록을 닫은 뒤에도
 * 권한 거절 403 이 409 보다 먼저다). 맞지 않는 단말(POP)의 401 문구는 `terminal-type-denied.ts` 가 바뀐 길(POP 자재 투입)을 알린다.
 * ⛔ 셋 다 계약이 ETag 를 선언하지 않았다 — `setEtag`·`runVersioned` 를 부르지 않는다.
 */
@Controller('production/operation-handovers')
export class OperationHandoverController {
  constructor(
    private readonly queries: OperationHandoverQueryService,
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
   * 확정 등록 — 닫았다. 다음 공정은 POP 자재 투입에서 반제품 LOT 을 스캔해 투입한다(그것이 계보를 잇는다).
   * 멱등 키는 그대로 받아 같은 키 재전송에 같은 409 를 돌려준다(옛 `:pick` 의 `USE_PICK_LOT` 과 같은 방식).
   */
  @Post()
  @Contract('POST /production/operation-handovers')
  create(@Req() request: Request): Promise<OperationHandoverView> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => {
      throw new ConflictException('user', '공정 인계는 반제품 투입으로 바뀌었습니다.', { code: HANDOVER_RETIRED });
    }, FAMILY_CONFLICT_CODE);
  }
}
