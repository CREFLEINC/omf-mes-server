import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { ApprovalService } from '../../core/approval';
import { PrismaService } from '../../prisma/prisma.service';
import { CONCESSION_APPROVAL_TYPE } from '../concession/concession-write.service';
import { ApprovalRouteSummary, approvalRouteSummary } from './approval-route-check';
import {
  DISPOSITION_APPROVAL_TYPE,
  DispositionApprovalApplied,
  DispositionApprovalOutcome,
  DispositionApprovalService,
} from './disposition-approval.service';
import { ApprovalNonconformanceSummary, DispositionApprovalView, approvalNonconformanceSummary } from './disposition-approval-view';
import { DispositionDecisionCreate } from './disposition-write.service';

/**
 * 폐기·선별 처분 결재(omf-all-around#352) — 요청(결재선 없으면 바로 판정) · 목록 · 반영 · 결재함 부적합 요약.
 * ⭐ If-Match 는 처분 판정 저장과 같은 «부적합» ETag 다. 403 게이트는 `manual-permissions.ts`(요청 `W-03-10` · 반영 `W-03-10`·`W-03-09`).
 */
@Controller('quality')
export class DispositionApprovalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: DispositionApprovalService,
    private readonly idempotency: IdempotencyService,
    private readonly routes: ApprovalService,
  ) {}

  /** 판정 확인 팝업 — 처분(폐기·선별)·특채 결재선이 있는지와 결재자. 없으면 저장이 결재 없이 바로 반영된다(#352). */
  @Get('disposition-approval-routes')
  @Contract('GET /quality/disposition-approval-routes')
  async approvalRoutes(): Promise<{ items: ApprovalRouteSummary[] }> {
    const items = await Promise.all(
      [DISPOSITION_APPROVAL_TYPE, CONCESSION_APPROVAL_TYPE].map((type) => approvalRouteSummary(this.prisma, this.routes, type)),
    );
    return { items };
  }

  @Post('nonconformances/:nonconformanceId/disposition-approvals')
  @Contract('POST /quality/nonconformances/{nonconformanceId}/disposition-approvals')
  async request(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('nonconformanceId', ParseIntPipe) nonconformanceId: number,
    @Body() body: DispositionDecisionCreate,
  ): Promise<DispositionApprovalOutcome> {
    const version = requiredVersion(request);
    const appUserId = userOf(request);
    const done = await runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.approvals.request(nonconformanceId, version, body, appUserId),
      FAMILY_CONFLICT_CODE,
    );
    setEtag(response, done.versionNo);
    return done.result;
  }

  @Get('nonconformances/:nonconformanceId/disposition-approvals')
  @Contract('GET /quality/nonconformances/{nonconformanceId}/disposition-approvals')
  async list(@Param('nonconformanceId', ParseIntPipe) nonconformanceId: number): Promise<{ items: DispositionApprovalView[] }> {
    return { items: await this.approvals.list(nonconformanceId) };
  }

  @Post('disposition-approvals/:dispositionApprovalId\\:apply')
  @Contract('POST /quality/disposition-approvals/{dispositionApprovalId}:apply')
  @HttpCode(HttpStatus.OK)
  async apply(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('dispositionApprovalId', ParseIntPipe) dispositionApprovalId: number,
  ): Promise<DispositionApprovalApplied> {
    const version = requiredVersion(request);
    const appUserId = userOf(request);
    const done = await runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.approvals.apply(dispositionApprovalId, version, appUserId),
      FAMILY_CONFLICT_CODE,
    );
    setEtag(response, done.versionNo);
    return done.result;
  }

  @Get('approval-requests/:approvalRequestId/nonconformance-summary')
  @Contract('GET /quality/approval-requests/{approvalRequestId}/nonconformance-summary')
  async summary(
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRequestId', ParseIntPipe) approvalRequestId: number,
  ): Promise<ApprovalNonconformanceSummary> {
    const { summary, versionNo } = await approvalNonconformanceSummary(this.prisma, approvalRequestId);
    setEtag(response, versionNo);
    return summary;
  }
}

function requiredVersion(request: Request): number {
  // 가드가 이 자리에서 If-Match 를 이미 필수로 막았다 — 여기 오면 값이 있다.
  const version = ifMatchVersion(request);
  if (version === undefined) throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  return version;
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
