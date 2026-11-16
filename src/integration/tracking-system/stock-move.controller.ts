import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { ERROR_CODE, field, one } from '../../common/errors';
import { StockMove, StockMoveService } from './stock-move.service';

/** flowtrack 포장 입고이동(flowtrack 연동 제안 §3-3). 연동 단말 토큰 전용. */
@Controller('integration/tracking-system/stock-moves')
export class StockMoveController {
  constructor(private readonly stockMoves: StockMoveService) {}

  @Post()
  @Contract('POST /integration/tracking-system/stock-moves')
  @HttpCode(HttpStatus.OK)
  receive(@Req() request: Request, @Body() body: StockMove): Promise<{ replayed: boolean }> {
    const terminal = currentTerminal(request);
    // 계정 세션은 권한 검사 없이 여기까지 온다(계약에 403 이 없다) — 사람이 보내는 전송이 아니다.
    if (terminal === undefined) throw loginRequired();
    if (request.header('Idempotency-Key') !== body.transmissionId) {
      throw one(field('transmissionId', ERROR_CODE.INVALID, 'Idempotency-Key 와 전송 번호가 다릅니다.'));
    }
    return this.stockMoves.receive(body, terminal.plantId);
  }
}
