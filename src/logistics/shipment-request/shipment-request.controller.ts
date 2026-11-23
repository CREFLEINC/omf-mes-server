import { currentTerminal } from '../../auth/terminal-context';
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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import type { SessionScope } from '../../auth/session.types';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  ShipmentRequestQueryService,
  ShipmentRequestSummaryView,
} from './shipment-request-query.service';
import { ShipmentRequestFilters, ShipmentRequestQuery } from './shipment-request-query.sql';
import { ShipmentRequestView } from './shipment-request-view';
import { ConflictException } from '../../common/errors';
import { PICK_CONFLICT } from './shipment-lot-pick.service';
import { ShipmentRequestCreate, ShipmentRequestService } from './shipment-request.service';

/**
 * MES 출하작업지시 — 화면 `W-04-01`(편성) · `W-04-02`(목록·요약·상세) · `M-04-01`(피킹).
 *
 * 계약이 한 자원 아래 묶어 둔 5건이라 컨트롤러를 가르지 않는다(§7-3) — 조회 셋 + 편성 + `:pick`.
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회 셋은 403 을 «선언하지 않아» 더해도
 * 죽은 행이 되고, 403 을 «선언»한 둘은 `DERIVED_PERMISSIONS:180`(`W-04-01`)·`:181`(`M-04-01`)이
 * 이미 갖고 있다(§7-4). ⚠ 미등재였다면 가드가 던져 403 이 아니라 **500** 이다.
 * ⚠ OQC 생략 요청·실행 둘(omf-all-around#119 · 장부 P-83)은 도출표에 없어 `manual-permissions.ts` 에 `W-04-03` 으로 적었다.
 */
@Controller('logistics/shipment-requests')
export class ShipmentRequestController {
  constructor(
    private readonly queries: ShipmentRequestQueryService,
    private readonly requests: ShipmentRequestService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipment-requests')
  list(@Req() request: Request, @Query() query: ShipmentRequestQuery): Promise<PagedResponse<ShipmentRequestView>> {
    const terminal = currentTerminal(request);
    return this.queries.list(query, terminal === undefined ? undefined : {
      plantId: terminal.plantId,
      warehouseId: terminal.warehouseId ?? null,
      // PDA 는 피킹할 줄이 있는 지시서, POP(완료 찾기)은 사업부 지시서(피처 012 R-2).
      rule: terminal.terminalTypeCode === 'MOBILE' ? 'LINE' : 'BUSINESS_UNIT',
    }, accountScopes(request));
  }

  /**
   * ⛔⛔ **`@Get(':shipmentRequestId')` «앞»에 있어야 한다.** Nest 는 선언 순서대로 라우트를
   * 등록하고 Express 가 먼저 맞는 것을 잡는다 — 뒤에 두면 `summary` 가 경로 파라미터로 잡혀
   * `{field:'shipmentRequestId', code:'INVALID'}` 400(「정수여야 합니다」)이 나간다
   * (PR ③b 에서 실제로 그랬다). e2e L-53 이 이 순서를 잠근다. ⛔ 아래로 옮기지 마라.
   */
  @Get('summary')
  @Contract('GET /logistics/shipment-requests/summary')
  summary(@Req() request: Request, @Query() query: ShipmentRequestFilters): Promise<ShipmentRequestSummaryView> {
    return this.queries.summary(query, accountScopes(request));
  }

  @Get(':shipmentRequestId')
  @Contract('GET /logistics/shipment-requests/{shipmentRequestId}')
  async get(
    @Req() request: Request,
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentRequestView> {
    const view = await this.queries.get(shipmentRequestId, accountScopes(request));
    if (view.versionNo === undefined) throw new Error('출하작업지시 versionNo가 없습니다.');
    setEtag(response, view.versionNo);
    return view;
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
      () => this.requests.create(body, { appUserId: session.userId, scopes: session.scopes }),
      FAMILY_CONFLICT_CODE,
    );
  }

  /**
   * 옛 수량 피킹(`M-04-01` 옛 화면) — 피처 010 부터 LOT 통째 피킹(`:pick-lot`)만 받는다. 경로는 남겨 옛 PDA 가
   * 「업데이트하세요」를 알 수 있게 409 `USE_PICK_LOT` 로 답한다(배포 전 예약만 있는 옛 피킹은 출하 처리 경로로 끝낸다).
   */
  @Post(':shipmentRequestId/lines/:shipmentRequestLineId\\:pick')
  @Contract('POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick')
  @HttpCode(HttpStatus.OK)
  pick(@Req() request: Request): Promise<never> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => {
      throw new ConflictException('user', '수량 피킹은 더 쓰지 않습니다. LOT 을 스캔해 통째로 피킹하세요(앱을 업데이트하세요).', {
        code: PICK_CONFLICT.USE_PICK_LOT,
      });
    }, FAMILY_CONFLICT_CODE);
  }
}

/** 계정 세션의 데이터 범위(W-04-02 · 피처 012 D-12) — 단말 호출은 단말 범위가 따로 걸리므로 없다. */
function accountScopes(request: Request): SessionScope[] | undefined {
  return currentSession(request)?.scopes;
}
