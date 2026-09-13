import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { currentTerminalApprovalListScope } from '../../auth/terminal-app-read-scope';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ApprovalRequestQuery, ApprovalRequestService } from './approval-request.service';
import { ApprovalRequestDetailView, ApprovalRequestView } from './approval.mapper';

/** 계약 `ApprovalDecision` — 본문 자체가 선택이다(`requestBody.required: false`). */
interface ApprovalDecisionInput {
  comment?: string;
}

/** 계약 `ApprovalRejection` — `comment` 필수·`minLength: 1`. 검증은 계약 가드가 한다. */
interface ApprovalRejectionInput {
  comment: string;
}

/**
 * 결재함 조회 2건 + 결재 2건. 화면은 `W-CO-09`(결재함) · 현장 상신 화면(`W-01-13`·
 * `W-03-09`)이 함께 부른다.
 */
@Controller('app/approval-requests')
export class ApprovalRequestController {
  constructor(
    private readonly requests: ApprovalRequestService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/approval-requests')
  list(
    @Req() request: Request,
    @Query() query: ApprovalRequestQuery,
  ): Promise<PagedResponse<ApprovalRequestView>> {
    const terminalScope = currentTerminalApprovalListScope(request);
    return terminalScope
      ? this.requests.listForTerminal(query, terminalScope)
      : this.requests.list(query, actorId(request));
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

  @Post(':approvalRequestId\\:approve')
  @Contract('POST /app/approval-requests/{approvalRequestId}:approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRequestId', ParseIntPipe) approvalRequestId: number,
    // 본문 자체가 선택이라 아예 안 올 수 있다 — 계약 가드가 그 자리를 열어 둔다.
    @Body() body: ApprovalDecisionInput | undefined,
  ): Promise<ApprovalRequestDetailView> {
    const actor = actorId(request);
    return runVersioned<ApprovalRequestDetailView, 'detail'>(
      this.idempotency,
      request,
      response,
      'detail',
      (version) => this.requests.approve(approvalRequestId, version, actor, body?.comment),
    );
  }

  @Post(':approvalRequestId\\:reject')
  @Contract('POST /app/approval-requests/{approvalRequestId}:reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRequestId', ParseIntPipe) approvalRequestId: number,
    @Body() body: ApprovalRejectionInput,
  ): Promise<ApprovalRequestDetailView> {
    const actor = actorId(request);
    return runVersioned<ApprovalRequestDetailView, 'detail'>(
      this.idempotency,
      request,
      response,
      'detail',
      (version) => this.requests.reject(approvalRequestId, version, actor, body.comment),
    );
  }
}

/**
 * 「나」는 계정 세션 주체다 — `X-Worker-No` 는 기록 덧붙임용이지 주체가 아니다
 * (`notice.controller.ts:153` `actorOf` 복제 · 되돌림 §Y-5). 결재 기록에도 헤더를
 * 실을 칸이 없어(`approval_step` 은 `approver_id` 뿐이다) 사용자 id 만 뽑는다.
 */
function actorId(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
