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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  ShopfloorReceiptQuery,
  ShopfloorReceiptQueryService,
} from './shopfloor-receipt-query.service';
import { ShopfloorReceiptDetail, ShopfloorReceiptView } from './shopfloor-receipt-view';
import { ShopfloorReceiptCreate, ShopfloorReceiptService } from './shopfloor-receipt.service';

/**
 * 생산창고 입고 조회 2건 + 등록 1건. 소유 화면 조회는 `P-02-03`(I-9.md R-12) · 등록은
 * `M-01-09`(`derived-permissions.ts:186`).
 * ⛔ 조회 둘은 ETag 를 안 내린다 — 계약이 응답 헤더를 선언하지 않는다(I-9.md §1-1).
 * 403 도 미선언이라 권한 표를 손대지 않는다 — `derived-permissions.ts:70·71` 에 이미
 * `P-02-03` 이 등재돼 있으나 가드는 계약이 403 을 선언한 자리에서만 본다.
 */
@Controller('logistics/shopfloor-receipts')
export class ShopfloorReceiptController {
  constructor(
    private readonly queries: ShopfloorReceiptQueryService,
    private readonly receipts: ShopfloorReceiptService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shopfloor-receipts')
  list(@Query() query: ShopfloorReceiptQuery): Promise<PagedResponse<ShopfloorReceiptView>> {
    return this.queries.list(query);
  }

  @Get(':shopfloorReceiptId')
  @Contract('GET /logistics/shopfloor-receipts/{shopfloorReceiptId}')
  get(
    @Param('shopfloorReceiptId', ParseIntPipe) shopfloorReceiptId: number,
  ): Promise<ShopfloorReceiptDetail> {
    return this.queries.get(shopfloorReceiptId);
  }

  /**
   * 등록. ⛔ **ETag 를 안 내린다** — 계약 201 에 `headers` 가 없어 `runVersioned` 를 쓸 수
   * 없다(`material-issue-request.controller.ts:64-67` 그대로). `If-Match` 는 「선택」이라
   * **받되 무시한다** — 신규 생성이라 대조할 `version_no` 가 아직 없다. 400 도 내지 않는다.
   * `X-Worker-No` 는 계약 검증 가드가 안 보는 헤더라 서비스가 손으로 본다(`picking.controller.ts:70-74`
   * 모양).
   */
  @Post()
  @Contract('POST /logistics/shopfloor-receipts')
  create(
    @Req() request: Request,
    @Body() body: ShopfloorReceiptCreate,
  ): Promise<ShopfloorReceiptDetail> {
    const appUserId = userOf(request);
    const workerNo = request.headers['x-worker-no'];
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.receipts.create(body, appUserId, typeof workerNo === 'string' ? workerNo : undefined),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
