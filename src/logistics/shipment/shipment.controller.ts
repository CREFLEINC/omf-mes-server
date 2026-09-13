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
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentQuery } from './shipment-query.sql';
import {
  ShipmentCancelBody,
  ShipmentCancelRequestBody,
  ShipmentCancelService,
} from './shipment-cancel.service';
import { ShipmentConfirmService } from './shipment-confirm.service';
import { ShipmentCreateWrite } from './shipment-posting';
import { ShipmentService } from './shipment.service';
import { ShipmentDetailView, ShipmentView } from './shipment-view';

/**
 * MES 출하 — 화면 `W-04-04`(처리·확정) · `W-04-12`(취소) · `W-04-02`(목록).
 *
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회는 403 을 «선언하지 않아» 더해도 죽은
 * 행이 되고, 403 을 선언한 다섯은 `DERIVED_PERMISSIONS` 가 **이미 갖고 있다**(§1-1 실측
 * `:68`·`:69`·`:182`~`:185`·`:187`). ⚠ 미등재였다면 가드가 던져 403 이 아니라 **500** 이다.
 * ⛔ `manual-permissions.ts` 에 더하면 `operation-permissions.spec.ts:27-37`(순수 중복 금지)이 빨개진다.
 */
@Controller('logistics/shipments')
export class ShipmentController {
  constructor(
    private readonly queries: ShipmentQueryService,
    private readonly shipments: ShipmentService,
    private readonly confirms: ShipmentConfirmService,
    private readonly cancels: ShipmentCancelService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipments')
  list(@Req() request: Request, @Query() query: ShipmentQuery): Promise<PagedResponse<ShipmentView>> {
    return this.queries.list(query, currentTerminal(request)?.plantId);
  }

  @Get(':shipmentId')
  @Contract('GET /logistics/shipments/{shipmentId}')
  async get(
    @Param('shipmentId', ParseIntPipe) shipmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentDetailView> {
    const { view, versionNo } = await this.queries.get(shipmentId);
    // ⛔ 계약이 ETag 를 «상세에만» 선언했다 — :confirm·:cancel 의 If-Match 가 이 값을 담는다.
    // ⚠ Express 가 모든 200 에 약한 content ETag(W/"…")를 스스로 단다 — 목록에도 «헤더는»
    //   있다. 다른 것은 값이다: 여기만 숫자(version_no)라 If-Match 로 쓸 수 있다(e2e D-2).
    setEtag(response, versionNo);
    return view;
  }

  /**
   * ⭐ 201 본문은 **상세 뷰 그대로**다 — 계약이 `Shipment` 를 내리고 그 스키마가 `lines` 를
   * 선택으로 갖는다. 등록 직후 화면이 라인·배분을 다시 조회하지 않는다.
   * ⛔ 409 봉투가 **계열**이라(`ShipmentConflictResponse` — `code` 가 required) 다섯째 인자를
   * 넘긴다. 안 넘기면 멱등 충돌 409 에서 required 칸이 빠지는데 **e2e 로는 반증이 안 되고**
   * `family-conflict-code.spec.ts` 가 잡는다(조회 둘은 409 자체가 없어 안 넘긴다).
   */
  @Post()
  @Contract('POST /logistics/shipments')
  create(
    @Req() request: Request,
    @Body() body: ShipmentCreateWrite,
  ): Promise<ShipmentDetailView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.shipments.create(body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }

  /**
   * 미확정 → 확정 + ERP 송신 적재. ⭐ If-Match 가 **필수**(`IfMatchVersion`)라 가드가 헤더 없음을 400 으로
   * 먼저 막는다 — 여기 오면 값이 있다. `runVersioned` 가 새 판 번호를 ETag 로 싣는다.
   * ⛔ 409 봉투가 계열이라(`ShipmentConflictResponse` — `code` required) 여섯째 인자를 넘긴다.
   */
  @Post(':shipmentId\\:confirm')
  // ⛔ Nest 의 @Post 기본은 201 이다 — 계약은 200 이고, runVersioned 에 넘기는 OK 는 멱등 저장용일 뿐
  //    실제 응답 상태를 바꾸지 않는다(첫 e2e 가 201 을 받았다).
  @HttpCode(HttpStatus.OK)
  @Contract('POST /logistics/shipments/{shipmentId}:confirm')
  confirm(
    @Param('shipmentId', ParseIntPipe) shipmentId: number,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentDetailView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    // ⚠ 타입 인자를 적는다 — 안 적으면 `versionNo: number` 까지 T 로 추론돼 반환이 합집합이 된다.
    return runVersioned<ShipmentDetailView, 'shipment'>(
      this.idempotency,
      request,
      response,
      'shipment',
      (version) => this.confirms.confirm(shipmentId, version, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }

  /**
   * 취소 결재 상신. ⛔ 상태를 옮기지 않는다(시드 3값에 `CANCEL_REQUESTED` 가 없다) — 판 번호도 그대로라
   * 응답 ETag 가 요청의 If-Match 와 같다. 결재 진행 중인 출하는 확정이 409 로 막는다(J-7).
   */
  @Post(':shipmentId\\:request-cancel')
  @HttpCode(HttpStatus.OK)
  @Contract('POST /logistics/shipments/{shipmentId}:request-cancel')
  requestCancel(
    @Param('shipmentId', ParseIntPipe) shipmentId: number,
    @Body() body: ShipmentCancelRequestBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentDetailView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runVersioned<ShipmentDetailView, 'shipment'>(
      this.idempotency,
      request,
      response,
      'shipment',
      (version) => this.cancels.requestCancel(shipmentId, version, body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }

  /** 승인 뒤 취소 실행 — 역전기·전표 상태·예약·롤업·출하 상태가 한 트랜잭션이다(J-8 재판정 포함). */
  @Post(':shipmentId\\:cancel')
  @HttpCode(HttpStatus.OK)
  @Contract('POST /logistics/shipments/{shipmentId}:cancel')
  cancel(
    @Param('shipmentId', ParseIntPipe) shipmentId: number,
    @Body() body: ShipmentCancelBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentDetailView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runVersioned<ShipmentDetailView, 'shipment'>(
      this.idempotency,
      request,
      response,
      'shipment',
      (version) => this.cancels.cancel(shipmentId, version, body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }
}
