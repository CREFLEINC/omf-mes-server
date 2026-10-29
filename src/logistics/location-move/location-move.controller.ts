import { Body, Controller, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { StockTransferDetail } from '../stock-transfer/stock-transfer-view';
import { LocationMoveCreate, LocationMoveService } from './location-move.service';

/** 같은 창고 안 위치 이동 — 화면 `M-01-10`(창고 이동과 같다). */
@Controller('logistics/location-moves')
export class LocationMoveController {
  constructor(
    private readonly moves: LocationMoveService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Contract('POST /logistics/location-moves')
  create(@Req() request: Request, @Body() body: LocationMoveCreate): Promise<StockTransferDetail> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.moves.create(body, session.userId));
  }
}
