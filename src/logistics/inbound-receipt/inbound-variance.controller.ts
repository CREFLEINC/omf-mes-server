import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { InboundVarianceView } from './inbound-variance-view';
import { InboundVarianceService } from './inbound-variance.service';

/** 입하 차이 조회 1건 — 경로 축이 입하 라인이 아니라 `inbound-receipt-lines` 다(계약). */
@Controller('logistics/inbound-receipt-lines')
export class InboundVarianceController {
  constructor(private readonly variances: InboundVarianceService) {}

  @Get(':inboundReceiptLineId/variances')
  @Contract('GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances')
  async list(
    @Param('inboundReceiptLineId', ParseIntPipe) inboundReceiptLineId: number,
  ): Promise<{ items: InboundVarianceView[] }> {
    return { items: await this.variances.list(inboundReceiptLineId) };
  }
}
