import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import {
  HistoryItem,
  MaterialIssueRequestCancel,
  MaterialIssueRequestEditService,
  MaterialIssueRequestUpdate,
} from './material-issue-request-edit.service';
import { MaterialIssueRequestDetail } from './material-issue-request-view';

/** 출고 요청 수정·취소·이력 — 화면 `W-02-11`(피처 003). 저장 충돌은 본문 `versionNo` 로 가른다(계약). */
@Controller('logistics/material-issue-requests')
export class MaterialIssueRequestEditController {
  constructor(
    private readonly edits: MaterialIssueRequestEditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Put(':materialIssueRequestId')
  @Contract('PUT /logistics/material-issue-requests/{materialIssueRequestId}')
  update(
    @Req() request: Request,
    @Param('materialIssueRequestId', ParseIntPipe) id: number,
    @Body() body: MaterialIssueRequestUpdate,
  ): Promise<MaterialIssueRequestDetail> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.edits.update(id, body, appUserId));
  }

  @Post(':materialIssueRequestId\\:cancel')
  @Contract('POST /logistics/material-issue-requests/{materialIssueRequestId}:cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Req() request: Request,
    @Param('materialIssueRequestId', ParseIntPipe) id: number,
    @Body() body: MaterialIssueRequestCancel,
  ): Promise<MaterialIssueRequestDetail> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.edits.cancel(id, body, appUserId));
  }

  @Get(':materialIssueRequestId/history')
  @Contract('GET /logistics/material-issue-requests/{materialIssueRequestId}/history')
  history(@Param('materialIssueRequestId', ParseIntPipe) id: number): Promise<{ items: HistoryItem[] }> {
    return this.edits.history(id);
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
