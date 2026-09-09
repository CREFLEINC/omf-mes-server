import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { StockTransferQuery, StockTransferQueryService } from './stock-transfer-query.service';
import { StockTransferDetail, StockTransferLineView, StockTransferView } from './stock-transfer-view';
import { StockTransferCreate, StockTransferService } from './stock-transfer.service';
import {
  ArriveContext,
  StockTransferArrive,
  TransferArriveService,
} from './transfer-arrive.service';

/**
 * 재고 이동 6건 — 조회 3건 + 반출 등록 + 도착 확정(PR ①②③) + 라인 치환 자물쇠(PR ④).
 * `M-01-10` 이 소유하는 화면 — 조회는 계약이 403 을 선언하지 않아 `manual-permissions.ts`
 * 에 없다(`permission.guard.ts:35-40`).
 */
@Controller('logistics/stock-transfers')
export class StockTransferController {
  constructor(
    private readonly queries: StockTransferQueryService,
    private readonly transfers: StockTransferService,
    private readonly arrivals: TransferArriveService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/stock-transfers')
  list(@Query() query: StockTransferQuery): Promise<PagedResponse<StockTransferView>> {
    return this.queries.list(query);
  }

  @Get(':stockTransferId')
  @Contract('GET /logistics/stock-transfers/{stockTransferId}')
  async get(
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockTransferDetail> {
    const { stockTransfer, lines, versionNo } = await this.queries.get(stockTransferId);
    setEtag(response, versionNo);
    return { stockTransfer, lines };
  }

  /**
   * ⭐ 생성과 반출이 한 오퍼레이션이다 — 201 이 나온 시점에 원장 1단째가 이미 서 있다.
   * ⛔ If-Match 는 「선택」이라 꺼내지 않는다 — 새 자원이라 대조할 버전이 없다(C-9 · 출고 선례).
   */
  @Post()
  @Contract('POST /logistics/stock-transfers')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: StockTransferCreate,
  ): Promise<StockTransferDetail> {
    const appUserId = userOf(request);
    const workerNo = request.header('X-Worker-No') ?? undefined;
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.transfers.create(body, workerNo, appUserId),
    );
    setEtag(response, result.versionNo);
    return result.detail;
  }

  /**
   * ⭐ 도착이 원장 2단째를 세운다 — 200 이 나온 시점에 잔액이 `IN_TRANSIT` 에서 실제 위치로 옮겨져 있다.
   * ⛔ ETag 를 안 내린다 — 계약 200 에 응답 헤더 선언이 0건이다. If-Match 는 «선택»이라
   *    없으면 대조를 건너뛴다(오프라인 큐가 토큰을 안 싣는다 · C-9).
   */
  @Post(':stockTransferId\\:arrive')
  @Contract('POST /logistics/stock-transfers/{stockTransferId}:arrive')
  @HttpCode(HttpStatus.OK)
  arrive(
    @Req() request: Request,
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
    @Body() body: StockTransferArrive,
  ): Promise<StockTransferDetail> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.arrivals.arrive(stockTransferId, body, contextOf(request)),
    );
  }

  /** ⛔ 자식 컬렉션 GET 이라 ETag 를 안 붙인다(계약 원문 — 잠그는 단위는 부모다). */
  @Get(':stockTransferId/lines')
  @Contract('GET /logistics/stock-transfers/{stockTransferId}/lines')
  async lines(
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
  ): Promise<{ items: StockTransferLineView[] }> {
    return { items: await this.queries.lines(stockTransferId) };
  }

  /**
   * ⭐ 「자물쇠까지만」이다(통보 123) — 오늘 실재하는 모든 전표가 반출을 끝낸 상태라 200 이
   * 도달 불가하고, 이 호출은 400 `STATE_LOCKED` 로 닫힌다. 그래서 본문을 «안 받는다» —
   * 계약 검증 가드가 `items` 의 모양을 이미 보고, 서비스는 한 칸도 읽지 않는다.
   * ⭐ If-Match 는 **부모** `stock_transfer.version_no` 다(계약 · B-1-1).
   * ⛔ ETag 를 안 내린다 — 계약 200 에 응답 헤더 선언이 0건이다. 그래서 `runVersioned` 가
   *    아니라 `runIdempotent` 다(형제 조정은 헤더가 «선언돼» 내린다 — 베끼면 어긋난다).
   */
  @Put(':stockTransferId/lines')
  @Contract('PUT /logistics/stock-transfers/{stockTransferId}/lines')
  replaceLines(
    @Req() request: Request,
    @Param('stockTransferId', ParseIntPipe) stockTransferId: number,
  ): Promise<{ items: StockTransferLineView[] }> {
    const version = versionOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.transfers.replaceLines(stockTransferId, version),
    );
  }
}

/** ⛔ `runVersioned` 를 못 쓴다 — 응답에 ETag 가 없어 새 토큰을 내릴 자리가 없다(출고 선례). */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}

/** 헤더는 계약 검증 가드가 안 본다 — 사번 필수 판정은 서비스 몫이다(적치 선례). */
function contextOf(request: Request): ArriveContext {
  const workerNo = request.header('X-Worker-No');
  return {
    workerNo: typeof workerNo === 'string' ? workerNo : undefined,
    version: ifMatchVersion(request),
    appUserId: userOf(request),
  };
}
