import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminalLogisticsWorkerId } from '../../auth/terminal-logistics-scope';
import { runDocumentIssueWriteWithRetry } from '../../app/document-issue/document-issue-sequence';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf, runIdempotent } from '../../common/master';
import { ProductLotSplitConfirmBody, ProductLotSplitConfirmService } from './product-lot-split-confirm.service';
import { ProductLotSplitListQuery, ProductLotSplitPage, ProductLotSplitQueryService } from './product-lot-split-query.service';
import { ProductLotSplitBody, ProductLotSplitService, SplitActor } from './product-lot-split.service';
import { ProductLotSplitLookup, ProductLotSplitResult, ProductLotSplitView, requireTerminal } from './product-lot-split-view';

const SPLIT = 'POST /logistics/product-lot-splits';
const CONFIRM = 'POST /logistics/product-lot-splits/{productLotSplitId}:confirm';

/**
 * 생산 LOT 수량 분리(피처 013 · omf-all-around#303) — POP P-04-08 스캔 조회·분리·확인 대기 목록.
 * ⛔ 단말 전용이다(관리웹 화면이 없다). 409 봉투가 계열(`ShipmentConflictResponse`)이라 `FAMILY_CONFLICT_CODE` 를 넘긴다.
 */
@Controller('logistics')
export class ProductLotSplitController {
  constructor(
    private readonly splits: ProductLotSplitService,
    private readonly queries: ProductLotSplitQueryService,
    private readonly confirms: ProductLotSplitConfirmService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('product-lot-splits\\:lookup')
  @Contract('GET /logistics/product-lot-splits:lookup')
  lookup(@Req() request: Request, @Query('lotNo') lotNo: string | undefined): Promise<ProductLotSplitLookup> {
    return this.queries.lookup(lotNo, requireTerminal(request));
  }

  /** 분리 — 발행 회차가 다른 요청과 부딪히면 트랜잭션째 다시 돈다(`runDocumentIssueWriteWithRetry`). */
  @Post('product-lot-splits')
  @Contract('POST /logistics/product-lot-splits')
  @HttpCode(HttpStatus.OK)
  async split(@Req() request: Request, @Body() body: ProductLotSplitBody): Promise<ProductLotSplitResult> {
    const actor = splitActorOf(request, SPLIT);
    const context = idempotencyContextOf(request, HttpStatus.OK, FAMILY_CONFLICT_CODE);
    return runDocumentIssueWriteWithRetry(async () => {
      const outcome = await this.idempotency.run(context, (tx) => this.splits.splitWithin(tx, body, { ...actor, fingerprint: context.fingerprint }));
      return outcome.body;
    });
  }

  /** PDA 분리 확인(M-04-05) — 두 라벨이 그 분리의 짝이면 확인한다. */
  @Post('product-lot-splits/:productLotSplitId\\:confirm')
  @Contract('POST /logistics/product-lot-splits/{productLotSplitId}:confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Req() request: Request,
    @Param('productLotSplitId', ParseIntPipe) productLotSplitId: number,
    @Body() body: ProductLotSplitConfirmBody,
  ): Promise<ProductLotSplitView> {
    const actor = splitActorOf(request, CONFIRM);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.confirms.confirmWithin(tx, productLotSplitId, body, actor), FAMILY_CONFLICT_CODE);
  }

  @Get('product-lot-splits')
  @Contract('GET /logistics/product-lot-splits')
  list(@Req() request: Request, @Query() query: ProductLotSplitListQuery): Promise<ProductLotSplitPage> {
    return this.queries.list(query, requireTerminal(request));
  }
}

/** 단말 쓰기 주체 — 사번 작업자는 범위 검사가 심었다(`terminal-logistics-scope`). */
export function splitActorOf(request: Request, operationKey: string): Omit<SplitActor, 'fingerprint'> {
  const terminal = requireTerminal(request);
  const workerId = currentTerminalLogisticsWorkerId(request);
  const workerNo = request.header('X-Worker-No');
  const correlationId = request.header('Idempotency-Key');
  if (workerId === undefined || !workerNo || !correlationId) throw new UnauthorizedException('단말 작업자와 멱등 키가 필요합니다.');
  return { workerId, workerNo, terminalId: terminal.terminalId, plantId: terminal.plantId, correlationId, operationKey };
}
