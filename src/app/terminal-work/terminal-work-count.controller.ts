import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { MobileWorkCounts, PopWorkCounts, TerminalWorkCountService } from './terminal-work-count.service';

/** 단말 작업 화면의 남은 작업 수(모바일 홈·POP 화면 이동 배지 · omf-all-around#190 · 장부 P-137). 단말 토큰 전용. */
@Controller('app/terminal-work-counts')
export class TerminalWorkCountController {
  constructor(private readonly counts: TerminalWorkCountService) {}

  @Get()
  @Contract('GET /app/terminal-work-counts')
  get(@Req() request: Request): Promise<MobileWorkCounts | PopWorkCounts> {
    const terminal = currentTerminal(request);
    // 계정 세션으로는 셀 단말이 없다 — 단말 토큰만 받는다.
    if (terminal === undefined) throw loginRequired();
    return this.counts.counts(terminal);
  }
}
