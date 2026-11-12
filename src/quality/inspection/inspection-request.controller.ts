import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf, runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import { InspectionHistory, InspectionHistoryService } from './inspection-history.service';
import { InspectionRequestDetailView, InspectionRequestListQuery, InspectionRequestService } from './inspection-request.service';
import { InspectionRequestView } from './inspection-request-view';
import { InspectionRequestCancelConfirm, InspectionRequestConfirm, IqcRequestConfirmService } from './iqc-request-confirm.service';
import { OqcSerialQueryService } from './oqc-serial-query.service';

/**
 * 검사 의뢰 조회(I-19 PR ②)와 입하 LOT 검사의 판정 확정·확정 취소(피처 005 §8). 등록 경로는 두지 않는다 — 서버가 입고·실적에서 만든다(계약).
 * 확정·취소 응답은 상세 조회와 같은 모양이라 커밋 뒤 상세를 다시 읽어 낸다(재전송도 지금 상세).
 */
@Controller('quality/inspection-requests')
export class InspectionRequestController {
  constructor(
    private readonly requests: InspectionRequestService,
    private readonly histories: InspectionHistoryService,
    private readonly oqcSerials: OqcSerialQueryService,
    private readonly confirms: IqcRequestConfirmService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-requests')
  list(@Req() request: Request, @Query() query: InspectionRequestListQuery): Promise<PagedResponse<InspectionRequestView>> {
    return this.requests.list(query, currentTerminalQualityReadScope(request));
  }

  /** ⛔ ETag 를 안 낸다(계약 미선언). */
  @Get(':inspectionRequestId')
  @Contract('GET /quality/inspection-requests/{inspectionRequestId}')
  detail(@Req() request: Request, @Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number): Promise<InspectionRequestDetailView> {
    return this.requests.detail(inspectionRequestId, currentTerminalQualityReadScope(request));
  }

  /** 검사 대상 이력 — 전달 · 회차 · LOT 상태 전이를 시간순으로(omf-all-around#61 · 장부 P-55). */
  @Get(':inspectionRequestId/history')
  @Contract('GET /quality/inspection-requests/{inspectionRequestId}/history')
  history(@Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number): Promise<InspectionHistory> {
    return this.histories.history(inspectionRequestId);
  }

  /** 시리얼 OQC — 이 의뢰의 회차들이 쓴 시리얼 판정(omf-all-around#68 · 장부 P-101). */
  @Get(':inspectionRequestId/oqc-serials')
  @Contract('GET /quality/inspection-requests/{inspectionRequestId}/oqc-serials')
  oqcSerialsOf(@Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number) {
    return this.oqcSerials.ofRequest(inspectionRequestId);
  }

  @Post(':inspectionRequestId\\:confirm')
  @Contract('POST /quality/inspection-requests/{inspectionRequestId}:confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Req() request: Request,
    @Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number,
    @Body() body: InspectionRequestConfirm,
  ): Promise<InspectionRequestDetailView> {
    const context = idempotencyContextOf(request, HttpStatus.OK, FAMILY_CONFLICT_CODE);
    await this.confirms.confirm(context, inspectionRequestId, body, userOf(request));
    return this.requests.detail(inspectionRequestId);
  }

  @Post(':inspectionRequestId\\:cancel-confirm')
  @Contract('POST /quality/inspection-requests/{inspectionRequestId}:cancel-confirm')
  @HttpCode(HttpStatus.OK)
  async cancelConfirm(
    @Req() request: Request,
    @Param('inspectionRequestId', ParseIntPipe) inspectionRequestId: number,
    @Body() body: InspectionRequestCancelConfirm,
  ): Promise<InspectionRequestDetailView> {
    const appUserId = userOf(request);
    await runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.confirms.cancelConfirm(tx, inspectionRequestId, body, appUserId));
    return this.requests.detail(inspectionRequestId);
  }
}

/** 확정·취소는 계정 세션만 — LOT 상태 이력·확정한 사람이 계정이다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
