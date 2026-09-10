import { Body, Controller, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import {
  StockReinstatementCreate,
  StockReinstatementService,
  StockReinstatementView,
} from './stock-reinstatement.service';

/**
 * 재고 재등록 — 화면 `W-04-11`. ⛔ `X-Worker-No` 를 안 받는다 — 관리웹 전용이고 행위자는 계정 세션이다
 * (계약 `x-internal-note` · D-5 · F-2). ⛔ If-Match 도 없다 — 컬렉션 POST 라 토큰은 본문 `lot.versionNo` 다.
 * ⛔ `OPERATION_PERMISSIONS` 0줄 — `DERIVED_PERMISSIONS:187`(`W-04-11`)이 이미 갖고 있다.
 */
@Controller('logistics/stock-reinstatements')
export class StockReinstatementController {
  constructor(
    private readonly reinstatements: StockReinstatementService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * ⛔ 409 봉투가 계열이라(`StockReinstatementConflictResponse` — `code` required) 다섯째 인자를 넘긴다.
   * ⚠ 그 스키마에는 `conflictCause` 칸이 «없다» — 공용 봉투가 언제나 싣는다(통보 221 ⓒ).
   */
  @Post()
  @Contract('POST /logistics/stock-reinstatements')
  create(@Req() request: Request, @Body() body: StockReinstatementCreate): Promise<StockReinstatementView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.reinstatements.create(body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
  }
}
