import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { PagedResponse } from '../../common/pagination';
import { assertOperationPermission } from '../../common/permissions';
import {
  AllocationCandidateView,
  InboundAllocationView,
  UnallocatedLineView,
  parseAllocationBody,
  parsePathId,
  parseUnallocatedQuery,
} from './inbound-allocation-view';
import { InboundAllocationService } from './inbound-allocation.service';

/** 배정은 초과 입하 분리 화면(W-01-03)의 일이다 — 보기·더하기·빼기 모두 그 화면 권한으로 본다(초과분 경로와 같다). */
const OPERATION = 'POST /logistics/inbound-receipts:split';
const LINE_ID = 'inboundReceiptLineId';

/**
 * 입하 줄 ↔ P/O 라인 배정. ⛔ 이 경로들은 계약 사본에 없어 `@Contract` 를 달 수 없고, 그래서 인증·권한 가드가 이 핸들러를
 * 보지 않는다. 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401 · 오퍼레이션 권한 403)를 여기서 부른다(P-58 과 같은 길).
 * 정본에 경로가 실려 오면 `@Contract` 를 달고 이 수동 인증·검사를 지운다.
 */
@Controller('logistics')
export class InboundAllocationController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly allocations: InboundAllocationService,
  ) {}

  @Get('inbound-unallocated')
  async listUnallocated(
    @Req() request: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<PagedResponse<UnallocatedLineView>> {
    await this.authorize(request);
    return this.allocations.listUnallocated(parseUnallocatedQuery(query));
  }

  @Get('inbound-receipt-lines/:inboundReceiptLineId/allocation-candidates')
  async candidates(
    @Req() request: Request,
    @Param(LINE_ID) lineId: string,
  ): Promise<{ items: AllocationCandidateView[] }> {
    await this.authorize(request);
    return { items: await this.allocations.candidates(parsePathId(LINE_ID, lineId)) };
  }

  @Post('inbound-receipt-lines/:inboundReceiptLineId/allocations')
  @HttpCode(HttpStatus.CREATED)
  async add(@Req() request: Request, @Param(LINE_ID) lineId: string, @Body() body: unknown): Promise<InboundAllocationView> {
    const session = await this.authorize(request);
    const { purchaseOrderLineId, qty } = parseAllocationBody(body);
    return this.allocations.addToLine(parsePathId(LINE_ID, lineId), purchaseOrderLineId, qty, session.userId);
  }

  @Delete('inbound-receipt-lines/:inboundReceiptLineId/allocations/:inboundReceiptPoAllocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() request: Request,
    @Param(LINE_ID) lineId: string,
    @Param('inboundReceiptPoAllocationId') allocationId: string,
  ): Promise<void> {
    const session = await this.authorize(request);
    await this.allocations.removeFromLine(
      parsePathId(LINE_ID, lineId),
      parsePathId('inboundReceiptPoAllocationId', allocationId),
      session.userId,
    );
  }

  private async authorize(request: Request): Promise<Session> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    assertOperationPermission(session, OPERATION);
    return session;
  }
}
