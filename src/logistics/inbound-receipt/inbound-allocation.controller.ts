import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { assertOperationPermission } from '../../common/permissions';
import {
  AllocationCandidateView,
  InboundAllocationView,
  UnallocatedContractQuery,
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
 * 입하 줄 ↔ P/O 라인 배정(장부 P-115). 단말 범위 표에 없어 단말 토큰은 401 이다.
 * ⛔ 더하기·빼기는 계약에 아직 없어 `@Contract` 를 달 수 없고, 그래서 인증·권한 가드가 그 핸들러를 보지 않는다.
 * 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401 · 오퍼레이션 권한 403)를 여기서 부른다(P-58 과 같은 길).
 */
@Controller('logistics')
export class InboundAllocationController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly allocations: InboundAllocationService,
  ) {}

  @Get('inbound-unallocated')
  @Contract('GET /logistics/inbound-unallocated')
  listUnallocated(@Query() query: UnallocatedContractQuery): Promise<PagedResponse<UnallocatedLineView>> {
    return this.allocations.listUnallocated(parseUnallocatedQuery(query));
  }

  @Get('inbound-receipt-lines/:inboundReceiptLineId/allocation-candidates')
  @Contract('GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/allocation-candidates')
  async candidates(@Param(LINE_ID) lineId: number): Promise<{ items: AllocationCandidateView[] }> {
    return { items: await this.allocations.candidates(BigInt(lineId)) };
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
