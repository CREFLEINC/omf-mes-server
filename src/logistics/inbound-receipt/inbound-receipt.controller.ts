import {
  Body,
  Controller,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { InboundReceiptCreateInput } from './inbound-receipt-rules';
import { InboundReceiptDetail } from './inbound-receipt-view';
import { InboundReceiptService } from './inbound-receipt.service';

/** 입하 쓰기 — 화면 `M-01-01`(등록). 조회·수정·치환·분리는 뒤 PR 이 같은 컨트롤러에 붙인다. */
@Controller('logistics/inbound-receipts')
export class InboundReceiptController {
  constructor(
    private readonly inboundReceipts: InboundReceiptService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Contract('POST /logistics/inbound-receipts')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: InboundReceiptCreateInput,
  ): Promise<InboundReceiptDetail> {
    // ⛔ `runVersioned` 가 아니다 — 계약의 `If-Match` 는 «선택»이고 새 자원을 만드는
    //    POST 라 대조할 버전이 없다. 값이 실려 와도 무시한다(오프라인 큐는 토큰을 안
    //    싣는다 · 공유계약 C-9 · I-3.md §6-3).
    const appUserId = userOf(request);
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.inboundReceipts.create(body, appUserId),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
