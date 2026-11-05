import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE } from '../../common/idempotency';
import { PrismaService } from '../../prisma/prisma.service';
import { scopedPlantIds } from '../production-order/production-order-scope';
import { ProductionOrderService } from '../production-order/production-order.service';
import { ProposalConfirmBody } from './proposal-confirm-check';
import { ProposalConfirmResult, PlanProposalService } from './plan-proposal.service';
import { ProposalView } from './proposal-view';

/** ERP W/O 계획 제안 조회·선택 확정. 사용자 데이터 범위는 ERP W/O 목록과 같은 규칙이다. */
@Controller('planning')
export class PlanProposalController {
  constructor(
    private readonly proposals: PlanProposalService,
    private readonly orders: ProductionOrderService,
    private readonly prisma: PrismaService,
  ) {}

  /** `productionOrderIds` 는 가드가 쉼표 목록을 배열로 나누고 형·범위·개수를 계약대로 본 값이다. */
  @Get('production-orders\\:plan-proposals')
  @Contract('GET /planning/production-orders:plan-proposals')
  async propose(
    @Req() request: Request,
    @Query('productionOrderIds') productionOrderIds: number[],
  ): Promise<{ items: ProposalView[]; notFoundProductionOrderIds: number[] }> {
    return this.proposals.propose(productionOrderIds, await scopedPlantIds(this.prisma, userOf(request)));
  }

  /** 범위 밖이면 404 — 멱등 처리보다 먼저 막는다. */
  @Post('production-orders/:productionOrderId\\:confirm-plan-proposal')
  @Contract('POST /planning/production-orders/{productionOrderId}:confirm-plan-proposal')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Req() request: Request,
    @Param('productionOrderId', ParseIntPipe) productionOrderId: number,
    @Body() body: ProposalConfirmBody,
  ): Promise<ProposalConfirmResult> {
    const appUserId = userOf(request);
    await this.orders.assertInScope(productionOrderId, appUserId);
    return this.proposals.confirm(request, productionOrderId, body, appUserId, FAMILY_CONFLICT_CODE);
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
