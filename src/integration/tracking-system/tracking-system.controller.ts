import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { ERROR_CODE, field, one } from '../../common/errors';
import { StockIssue, StockIssueService } from './stock-issue.service';
import { StockMove, StockMoveService } from './stock-move.service';
import { WorkOrderCloseReport, WorkOrderCloseReportService } from './work-order-close-report.service';

/** flowtrack 포장 입고이동·출하 출고·마감 보고(flowtrack 연동 제안 §3-3 · §3-4 · §3-5). 연동 단말 토큰 전용. */
@Controller('integration/tracking-system')
export class TrackingSystemController {
  constructor(
    private readonly stockMoves: StockMoveService,
    private readonly stockIssues: StockIssueService,
    private readonly closeReports: WorkOrderCloseReportService,
  ) {}

  @Post('stock-moves')
  @Contract('POST /integration/tracking-system/stock-moves')
  @HttpCode(HttpStatus.OK)
  receiveStockMove(@Req() request: Request, @Body() body: StockMove): Promise<{ replayed: boolean }> {
    return this.stockMoves.receive(body, plantOf(request, body.transmissionId));
  }

  @Post('stock-issues')
  @Contract('POST /integration/tracking-system/stock-issues')
  @HttpCode(HttpStatus.OK)
  receiveStockIssue(@Req() request: Request, @Body() body: StockIssue): Promise<{ replayed: boolean }> {
    return this.stockIssues.receive(body, plantOf(request, body.transmissionId));
  }

  @Post('work-order-closes')
  @Contract('POST /integration/tracking-system/work-order-closes')
  @HttpCode(HttpStatus.OK)
  receiveCloseReport(@Req() request: Request, @Body() body: WorkOrderCloseReport): Promise<{ replayed: boolean }> {
    return this.closeReports.receive(body, plantOf(request, body.transmissionId));
  }
}

function plantOf(request: Request, transmissionId: string): bigint {
  const terminal = currentTerminal(request);
  // 계정 세션은 권한 검사 없이 여기까지 온다(계약에 403 이 없다) — 사람이 보내는 전송이 아니다.
  if (terminal === undefined) throw loginRequired();
  if (request.header('Idempotency-Key') !== transmissionId) {
    throw one(field('transmissionId', ERROR_CODE.INVALID, 'Idempotency-Key 와 전송 번호가 다릅니다.'));
  }
  return terminal.plantId;
}
