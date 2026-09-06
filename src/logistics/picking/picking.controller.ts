import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PickingLinePick, PickingPickService } from './picking-pick.service';
import { PickingOrderQuery, PickingQueryService } from './picking-query.service';
import { PickingLineView, PickingOrderDetail, PickingOrderView } from './picking-view';

/**
 * 피킹 지시 조회 2건. 화면 `M-01-08`(자재 출고 피킹).
 * ⛔ ETag 를 안 내린다 — 계약이 이 둘에 응답 헤더를 선언하지 않는다(I-8.md §1-1 · §9-2).
 * 403 도 미선언이라 권한 표를 손대지 않는다 — 목록의 `M-01-08` 은 도출표가 이미 갖고 있고
 * 가드는 계약이 403 을 선언한 자리에서만 본다(`permission.guard.ts`).
 */
@Controller('logistics/picking-orders')
export class PickingController {
  constructor(
    private readonly queries: PickingQueryService,
    private readonly picks: PickingPickService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/picking-orders')
  list(@Query() query: PickingOrderQuery): Promise<PagedResponse<PickingOrderView>> {
    return this.queries.list(query);
  }

  @Get(':pickingOrderId')
  @Contract('GET /logistics/picking-orders/{pickingOrderId}')
  get(
    @Param('pickingOrderId', ParseIntPipe) pickingOrderId: number,
  ): Promise<PickingOrderDetail> {
    return this.queries.get(pickingOrderId);
  }

  /**
   * 라인 피킹. ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**이라 토큰이 없으면 저쪽이
   * 던져 500 이 된다(`master-write.ts:48-51` · `:complete` 와 같은 가름).
   * ⛔ `setEtag` 를 부르지 않는다 — 계약이 이 200 에 응답 헤더를 선언하지 않았다(§9-2).
   */
  @Post(':pickingOrderId/lines/:pickingLineId\\:pick')
  @Contract('POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick')
  // 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다.
  @HttpCode(HttpStatus.OK)
  pick(
    @Req() request: Request,
    @Param('pickingOrderId', ParseIntPipe) pickingOrderId: number,
    @Param('pickingLineId', ParseIntPipe) pickingLineId: number,
    @Body() body: PickingLinePick,
  ): Promise<PickingLineView> {
    // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206-207`) — 필수 판정은 서비스 몫이다.
    const workerNo = request.headers['x-worker-no'];
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      version: ifMatchVersion(request),
      appUserId: session.userId,
    };

    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.picks.pick(pickingOrderId, pickingLineId, body, context),
    );
  }
}
