import { logisticsAppUserId } from '../../auth/terminal-logistics-scope';
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

import { Contract, ContractAlias } from '../../common/contract';
import { legacyInboundWriteClosed } from '../../core/lot';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  InboundReceiptLineQuery,
  InboundReceiptQuery,
  InboundReceiptQueryService,
} from './inbound-receipt-query.service';
import { InboundReceiptLineWriteInput } from './inbound-receipt-rules';
import {
  InboundReceiptLineListItem,
  InboundReceiptLineListQuery,
  InboundReceiptLineListService,
  SupplierLabelCount,
} from './inbound-receipt-line-list.service';
import { InboundReceiptUpdateInput, InboundReceiptUpdateService } from './inbound-receipt-update.service';
import { InboundReceiptDetail, InboundReceiptLineView, InboundReceiptView } from './inbound-receipt-view';

/** 입하 조회 3 + 수정 2 — 화면 `W-01-03`·`M-01-06`·`P-01-01`(조회). 등록은 닫혔다(`legacyInboundWriteClosed`). */
@Controller('logistics/inbound-receipts')
export class InboundReceiptController {
  constructor(
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
  create(@Req() request: Request): Promise<never> {
    return closed(this.idempotency, request);
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
  constructor(private readonly idempotency: IdempotencyService) {}

  @Post('inbound-receipts\\:split')
  @Contract('POST /logistics/inbound-receipts:split')
  create(@Req() request: Request): Promise<never> {
    return closed(this.idempotency, request);
  }
}

/** 줄마다 입하 한 건(장부 P-117) — 닫혔다. */
@Controller('logistics')
export class InboundReceiptPerLineController {
  constructor(private readonly idempotency: IdempotencyService) {}

  @Post('inbound-receipts\\:per-line')
  @Contract('POST /logistics/inbound-receipts:per-line')
  create(@Req() request: Request): Promise<never> {
    return closed(this.idempotency, request);
  }
}

/**
 * 입하 건을 가로지르는 입하 줄 목록·공급사별 수(장부 P-118) — POP 자재 LOT 라벨 발행(P-01-01)이 쓴다. 검사(인증·단말
 * 범위·권한·질의 형식)는 입하 목록과 같다(`@ContractAlias`). POP 단말은 그 공장으로 좁힌다.
 */
@Controller('logistics')
export class InboundReceiptLineListController {
  constructor(private readonly lineList: InboundReceiptLineListService) {}

  @Get('inbound-receipt-lines')
  @ContractAlias('GET /logistics/inbound-receipts')
  list(@Req() request: Request, @Query() query: InboundReceiptLineListQuery): Promise<PagedResponse<InboundReceiptLineListItem>> {
    return this.lineList.list(plantQuery(query, request));
  }

  @Get('inbound-receipt-lines\\:supplier-counts')
  @ContractAlias('GET /logistics/inbound-receipts')
  supplierCounts(@Req() request: Request, @Query() query: InboundReceiptLineListQuery): Promise<{ items: SupplierLabelCount[] }> {
    return this.lineList.supplierCounts(plantQuery(query, request));
  }
}

function closed(idempotency: IdempotencyService, request: Request): Promise<never> {
  return runIdempotent(idempotency, request, HttpStatus.CREATED, () => Promise.reject(legacyInboundWriteClosed()));
}

function userOf(request: Request): number {
  return logisticsAppUserId(request);
}

function plantQuery<T extends { plantId?: number }>(query: T, request: Request): T {
  const plantId = currentTerminal(request)?.plantId;
  return plantId === undefined ? query : { ...query, plantId: Number(plantId) };
}
