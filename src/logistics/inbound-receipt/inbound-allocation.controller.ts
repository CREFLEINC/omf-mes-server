import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { logisticsAppUserId } from '../../auth/terminal-logistics-scope';
import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  AllocationCandidateView,
  AllocationContractBody,
  InboundAllocationView,
  UnallocatedContractQuery,
  UnallocatedLineView,
  parseAllocationBody,
  parseUnallocatedQuery,
} from './inbound-allocation-view';
import { InboundAllocationService } from './inbound-allocation.service';

const LINE_ID = 'inboundReceiptLineId';

/** 입하 줄 ↔ P/O 라인 배정(장부 P-115). 단말 범위 표에 없어 단말 토큰은 401 이다. */
@Controller('logistics')
export class InboundAllocationController {
  constructor(private readonly allocations: InboundAllocationService) {}

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
  @Contract('POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/allocations')
  add(@Req() request: Request, @Param(LINE_ID) lineId: number, @Body() body: AllocationContractBody): Promise<InboundAllocationView> {
    const { purchaseOrderLineId, qty } = parseAllocationBody(body);
    return this.allocations.addToLine(BigInt(lineId), purchaseOrderLineId, qty, logisticsAppUserId(request));
  }

  @Delete('inbound-receipt-lines/:inboundReceiptLineId/allocations/:inboundReceiptPoAllocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Contract('DELETE /logistics/inbound-receipt-lines/{inboundReceiptLineId}/allocations/{inboundReceiptPoAllocationId}')
  remove(
    @Req() request: Request,
    @Param(LINE_ID) lineId: number,
    @Param('inboundReceiptPoAllocationId') allocationId: number,
  ): Promise<void> {
    return this.allocations.removeFromLine(BigInt(lineId), BigInt(allocationId), logisticsAppUserId(request));
  }
}
