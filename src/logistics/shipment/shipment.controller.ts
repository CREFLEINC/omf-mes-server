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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentQuery } from './shipment-query.sql';
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
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipments')
  list(@Query() query: ShipmentQuery): Promise<PagedResponse<ShipmentView>> {
    return this.queries.list(query);
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
}
