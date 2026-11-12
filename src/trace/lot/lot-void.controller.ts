import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { materialLotWriteActorOf } from '../../auth/terminal-material-lot-scope';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { LotVoidService, type MaterialLotVoidResult } from './lot-void.service';

/**
 * 대기 자재 관리 LOT 폐기(L5 · 피처 005 §1). 경로가 `/trace/lots:void` 라 `trace/lots` 컨트롤러에 둘 수 없다
 * (그쪽에 두면 `/trace/lots/:void` 가 된다).
 */
@Controller('trace')
export class LotVoidController {
  constructor(
    private readonly voids: LotVoidService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** 건별 결과라 일부만 폐기돼도 200 이다. */
  @Post('lots\\:void')
  @Contract('POST /trace/lots:void')
  @HttpCode(HttpStatus.OK)
  voidLots(@Req() request: Request, @Body() body: { lotIds: number[] }): Promise<MaterialLotVoidResult> {
    const actor = materialLotWriteActorOf(request, 'POST /trace/lots:void');
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.voids.void(body.lotIds, actor));
  }
}
