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
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  ShipmentRequestQueryService,
  ShipmentRequestSummaryView,
} from './shipment-request-query.service';
import { ShipmentRequestFilters, ShipmentRequestQuery } from './shipment-request-query.sql';
import { ShipmentRequestLineView, ShipmentRequestView } from './shipment-request-view';
import { ShipmentLinePick, ShipmentPickService } from './shipment-pick.service';
import { ShipmentRequestCreate, ShipmentRequestService } from './shipment-request.service';

/**
 * MES 출하작업지시 — 화면 `W-04-01`(편성) · `W-04-02`(목록·요약·상세) · `M-04-01`(피킹).
 *
 * 계약이 한 자원 아래 묶어 둔 5건이라 컨트롤러를 가르지 않는다(§7-3) — 조회 셋 + 편성 + `:pick`.
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회 셋은 403 을 «선언하지 않아» 더해도
 * 죽은 행이 되고, 403 을 «선언»한 둘은 `DERIVED_PERMISSIONS:180`(`W-04-01`)·`:181`(`M-04-01`)이
 * 이미 갖고 있다(§7-4). ⚠ 미등재였다면 가드가 던져 403 이 아니라 **500** 이다.
 */
@Controller('logistics/shipment-requests')
export class ShipmentRequestController {
  constructor(
    private readonly queries: ShipmentRequestQueryService,
    private readonly requests: ShipmentRequestService,
    private readonly picks: ShipmentPickService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipment-requests')
  list(@Query() query: ShipmentRequestQuery): Promise<PagedResponse<ShipmentRequestView>> {
    return this.queries.list(query);
  }

  /**
   * ⛔⛔ **`@Get(':shipmentRequestId')` «앞»에 있어야 한다.** Nest 는 선언 순서대로 라우트를
   * 등록하고 Express 가 먼저 맞는 것을 잡는다 — 뒤에 두면 `summary` 가 경로 파라미터로 잡혀
   * `{field:'shipmentRequestId', code:'INVALID', message:'must be integer'}` 400 이 나간다
   * (PR ③b 에서 실제로 그랬다). e2e L-53 이 이 순서를 잠근다. ⛔ 아래로 옮기지 마라.
   */
  @Get('summary')
  @Contract('GET /logistics/shipment-requests/summary')
  summary(@Query() query: ShipmentRequestFilters): Promise<ShipmentRequestSummaryView> {
    return this.queries.summary(query);
  }

  @Get(':shipmentRequestId')
  @Contract('GET /logistics/shipment-requests/{shipmentRequestId}')
  get(
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
  ): Promise<ShipmentRequestView> {
    return this.queries.get(shipmentRequestId);
  }

  /**
   * 편성 · 단독 생성(`W-04-01`). ⛔ **ETag 를 안 내린다** — 계약 201 에 `headers` 가 없어
   * `runVersioned` 를 쓸 수 없다. `If-Match` 도 계약이 안 실었다(§1-1 — 9건 전부 0).
   * ⭐ 201 본문은 `ShipmentRequest` 12칸이고 ③b 의 상세 뷰가 그대로 낸다.
   * ⛔ 409 봉투가 **계열**이라(`ShipmentConflictResponse` — `code` 가 required) 다섯째 인자를
   * 넘긴다. 안 넘기면 멱등 충돌 409 에서 required 칸이 빠지는데 e2e 로는 반증이 안 되고
   * `family-conflict-code.spec.ts` 가 잡는다(조회 셋은 409 자체가 없어 안 넘긴다).
   */
  @Post()
  @Contract('POST /logistics/shipment-requests')
  create(
    @Req() request: Request,
    @Body() body: ShipmentRequestCreate,
  ): Promise<ShipmentRequestView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.requests.create(body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }

  /**
   * ⭐⭐ 제품 LOT 피킹 확정(`M-04-01`) — 응답은 헤더가 아니라 **갱신된 라인**이다.
   * ⛔ `If-Match`·ETag 가 계약에 0건이라 `runVersioned`·`setEtag` 를 부르지 않는다(§1-1).
   * ⛔ 헤더는 계약 검증 가드가 «안 본다» — `X-Worker-No` 필수 판정은 서비스 몫이다.
   * ⛔ 409 봉투가 계열이라 `FAMILY_CONFLICT_CODE` 를 넘긴다 — 안 넘기면 멱등 충돌 409 에서
   *   required `code` 가 빠지고, 그 자리는 e2e 로 반증되지 않아 `family-conflict-code.spec.ts`
   *   가 유일한 그물이다.
   */
  @Post(':shipmentRequestId/lines/:shipmentRequestLineId\\:pick')
  @Contract('POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick')
  // 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다.
  @HttpCode(HttpStatus.OK)
  pick(
    @Req() request: Request,
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
    @Param('shipmentRequestLineId', ParseIntPipe) shipmentRequestLineId: number,
    @Body() body: ShipmentLinePick,
  ): Promise<ShipmentRequestLineView> {
    const workerNo = request.headers['x-worker-no'];
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () =>
        this.picks.pick(shipmentRequestId, shipmentRequestLineId, body, {
          workerNo: typeof workerNo === 'string' ? workerNo : undefined,
          appUserId: session.userId,
        }),
      FAMILY_CONFLICT_CODE,
    );
  }
}
