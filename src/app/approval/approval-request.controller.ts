import { Controller, Get, Param, ParseIntPipe, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ApprovalRequestQuery, ApprovalRequestService } from './approval-request.service';
import { ApprovalRequestDetailView, ApprovalRequestView } from './approval.mapper';

/**
 * 결재함 조회 2건. 화면은 `W-CO-09`(결재함) · 현장 상신 화면(`W-01-13`·`W-03-09`)이 함께
 * 부른다. ⛔ `:approve`/`:reject`(뒤 PR)는 이 컨트롤러에 없다.
 */
@Controller('app/approval-requests')
export class ApprovalRequestController {
  constructor(private readonly requests: ApprovalRequestService) {}

  @Get()
  @Contract('GET /app/approval-requests')
  list(
    @Req() request: Request,
    @Query() query: ApprovalRequestQuery,
  ): Promise<PagedResponse<ApprovalRequestView>> {
    return this.requests.list(query, actorId(request));
  }

  @Get(':approvalRequestId')
  @Contract('GET /app/approval-requests/{approvalRequestId}')
  async get(
    @Req() request: Request,
    @Param('approvalRequestId', ParseIntPipe) approvalRequestId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApprovalRequestDetailView> {
    const { detail, versionNo } = await this.requests.get(approvalRequestId, actorId(request));
    setEtag(response, versionNo);
    return detail;
  }
}

/**
 * 「나」는 계정 세션 주체다 — `X-Worker-No` 는 기록 덧붙임용이지 주체가 아니다
 * (`notice.controller.ts:153` `actorOf` 복제 · 되돌림 §Y-5). 조회만 있어 기록에
 * 헤더를 남길 자리가 없으므로 사용자 id 만 뽑는다.
 */
function actorId(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
