import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { InboundVarianceView } from './inbound-variance-view';
import { InboundVarianceCreateInput, InboundVarianceService } from './inbound-variance.service';

/** 입하 차이 조회·등록 — 경로 축이 입하가 아니라 `inbound-receipt-lines` 다(계약). */
@Controller('logistics/inbound-receipt-lines')
export class InboundVarianceController {
  constructor(
    private readonly variances: InboundVarianceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':inboundReceiptLineId/variances')
  @Contract('GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances')
  async list(
    @Param('inboundReceiptLineId', ParseIntPipe) inboundReceiptLineId: number,
  ): Promise<{ items: InboundVarianceView[] }> {
    return { items: await this.variances.list(inboundReceiptLineId) };
  }

  @Post(':inboundReceiptLineId/variances')
  @Contract('POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances')
  create(
    @Req() request: Request,
    @Param('inboundReceiptLineId', ParseIntPipe) inboundReceiptLineId: number,
    @Body() body: InboundVarianceCreateInput,
  ): Promise<InboundVarianceView> {
    // ⛔ ETag 가 없다 — 「한 번 등록하면 고칠 수 없다」라 대조할 버전 자체가 없다(계약).
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.variances.create(inboundReceiptLineId, body, session.userId),
    );
  }
}
