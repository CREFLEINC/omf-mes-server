import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { loginRequired } from '../../auth/authentication.guard';
import { Contract } from '../../common/contract';
import { ErpSyncStatus, ErpSyncStatusService } from './erp-sync-status.service';

/**
 * ERP 받기 표별 상태와 「지금 읽기」(장부 P-81). 화면은 관리웹 「ERP 연동 현황·이력」 탭(W-06-10).
 * 권한은 같은 화면의 오퍼레이션 것을 그대로 쓴다(`manual-permissions.ts`) — 상태는 연계 메시지 목록,
 * 「지금 읽기」는 실패 재처리와 같다.
 */
@Controller('integration/erp-sync/tables')
export class ErpSyncController {
  constructor(private readonly status: ErpSyncStatusService) {}

  @Get()
  @Contract('GET /integration/erp-sync/tables')
  list(): Promise<ErpSyncStatus> {
    return this.status.list();
  }

  /** 202 — 적어 두기만 한다. 돌았는지는 목록의 `requestedAt`·`running`·`lastFinishedAt` 으로 본다. */
  @Post(':interfaceCode\\:run')
  @Contract('POST /integration/erp-sync/tables/{interfaceCode}:run')
  @HttpCode(HttpStatus.ACCEPTED)
  run(
    @Req() request: Request,
    @Param('interfaceCode') interfaceCode: string,
  ): Promise<{ interfaceCode: string; requestedAt: string }> {
    // 계약이 세션 전용이라 인증 가드를 지났으면 세션이 있다.
    const session = currentSession(request);
    if (session === undefined) throw loginRequired();
    return this.status.request(interfaceCode, session.userId);
  }
}
