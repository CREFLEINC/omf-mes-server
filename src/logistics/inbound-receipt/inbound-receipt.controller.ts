import { logisticsAppUserId } from '../../auth/terminal-logistics-scope';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { currentTerminal } from '../../auth/terminal-context';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  InboundReceiptLineQuery,
  InboundReceiptQuery,
  InboundReceiptQueryService,
} from './inbound-receipt-query.service';
import { InboundReceiptCreateInput, InboundReceiptLineWriteInput } from './inbound-receipt-rules';
import { InboundReceiptSplitInput, InboundReceiptSplitService } from './inbound-receipt-split.service';
import { InboundReceiptUpdateInput, InboundReceiptUpdateService } from './inbound-receipt-update.service';
import { InboundReceiptDetail, InboundReceiptLineView, InboundReceiptView } from './inbound-receipt-view';
import { InboundReceiptService } from './inbound-receipt.service';

/** 입하 조회 3 + 등록 1 + 수정 2 — 화면 `W-01-03`·`M-01-06`·`P-01-01`(조회) · `M-01-01`. */
@Controller('logistics/inbound-receipts')
export class InboundReceiptController {
  constructor(
    private readonly inboundReceipts: InboundReceiptService,
    private readonly queries: InboundReceiptQueryService,
    private readonly updates: InboundReceiptUpdateService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/inbound-receipts')
  list(@Req() request: Request, @Query() query: InboundReceiptQuery): Promise<PagedResponse<InboundReceiptView>> {
    return this.queries.list(plantQuery(query, request));
  }

  @Get(':inboundReceiptId')
  @Contract('GET /logistics/inbound-receipts/{inboundReceiptId}')
  async get(
    @Param('inboundReceiptId', ParseIntPipe) inboundReceiptId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InboundReceiptDetail> {
    const { detail, versionNo } = await this.queries.get(inboundReceiptId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':inboundReceiptId/lines')
  @Contract('GET /logistics/inbound-receipts/{inboundReceiptId}/lines')
  async lines(
    @Param('inboundReceiptId', ParseIntPipe) inboundReceiptId: number,
    @Query() query: InboundReceiptLineQuery,
  ): Promise<{ items: InboundReceiptLineView[] }> {
    return { items: await this.queries.lines(inboundReceiptId, query) };
  }

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
    const actor = logisticsWriteActorOf(request, 'POST /logistics/inbound-receipts');
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.inboundReceipts.create(body, actor),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }

  @Put(':inboundReceiptId')
  @Contract('PUT /logistics/inbound-receipts/{inboundReceiptId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inboundReceiptId', ParseIntPipe) inboundReceiptId: number,
    @Body() body: InboundReceiptUpdateInput,
  ): Promise<InboundReceiptView> {
    const appUserId = userOf(request);
    return runVersioned<InboundReceiptView, 'inboundReceipt'>(
      this.idempotency,
      request,
      response,
      'inboundReceipt',
      (version) => this.updates.update(inboundReceiptId, version, body, appUserId),
    );
  }

  @Put(':inboundReceiptId/lines')
  @Contract('PUT /logistics/inbound-receipts/{inboundReceiptId}/lines')
  async replaceLines(
    @Req() request: Request,
    @Param('inboundReceiptId', ParseIntPipe) inboundReceiptId: number,
    @Body() body: { items: InboundReceiptLineWriteInput[] },
  ): Promise<{ items: InboundReceiptLineView[] }> {
    // ⛔ `runVersioned` 를 못 쓴다 — 그것은 무조건 ETag 를 내리는데 계약이 이 200 에 헤더를 선언하지
    //    않았다(잠그는 단위가 부모다 · B-1-1 · §6-3 · R-7 ⑤). 가드가 파싱해 둔 값을 직접 꺼낸다.
    const version = ifMatchVersion(request);
    if (version === undefined) throw new Error('If-Match 가 없는데 가드를 지났다 — 계약과 가드가 어긋났다');
    const appUserId = userOf(request);
    const items = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.updates.replaceLines(inboundReceiptId, version, body.items, appUserId),
    );
    return { items };
  }
}

/**
 * ⛔ 컬렉션에 붙는 액션(`/inbound-receipts:split`)은 컨트롤러 접두어를 «짧게» 잡아야 한다 —
 * Nest 가 컨트롤러 경로와 메서드 경로를 슬래시로 잇기 때문이다(`molds:import` 선례).
 */
@Controller('logistics')
export class InboundReceiptSplitController {
  constructor(
    private readonly splits: InboundReceiptSplitService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('inbound-receipts\\:split')
  @Contract('POST /logistics/inbound-receipts:split')
  create(
    @Req() request: Request,
    @Body() body: InboundReceiptSplitInput,
  ): Promise<{ created: InboundReceiptView[] }> {
    // ⛔ `If-Match` 가 아예 없다 — 계약이 등록과 달리 이 경로에 파라미터를 안 걸었다(§6-3).
    //    ETag 도 안 내린다(응답 헤더 선언 0건).
    const actor = logisticsWriteActorOf(request, 'POST /logistics/inbound-receipts:split');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.splits.create(body, actor),
    );
  }
}

function userOf(request: Request): number {
  return logisticsAppUserId(request);
}

function plantQuery<T extends { plantId?: number }>(query: T, request: Request): T {
  const plantId = currentTerminal(request)?.plantId;
  return plantId === undefined ? query : { ...query, plantId: Number(plantId) };
}
