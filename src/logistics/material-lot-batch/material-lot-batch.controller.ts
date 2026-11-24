import { Body, Controller, Get, HttpStatus, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminal } from '../../auth/terminal-context';
import { materialLotWriteActorOf } from '../../auth/terminal-material-lot-scope';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import type { MaterialLotBatchActor } from '../../core/lot';
import {
  MaterialLotBatchQuery,
  MaterialLotBatchQueryService,
  MaterialLotBatchRowView,
  WaitingMaterialLotGroupView,
  WaitingMaterialLotQuery,
} from './material-lot-batch-query.service';
import { MaterialLotBatchCreate, MaterialLotBatchCreated, MaterialLotBatchService } from './material-lot-batch.service';
import { MaterialLotPairQuery, MaterialLotPairService } from './material-lot-pair.service';
import { MaterialLotTabQuery, MaterialLotTabService } from './material-lot-tab.service';

/** 자재 관리 LOT 발행(POP P-01-01 · 웹 W-01-14) — 피처 005 §1. */
@Controller('logistics')
export class MaterialLotBatchController {
  constructor(
    private readonly batches: MaterialLotBatchService,
    private readonly queries: MaterialLotBatchQueryService,
    private readonly idempotency: IdempotencyService,
    private readonly tabs: MaterialLotTabService,
    private readonly pairList: MaterialLotPairService,
  ) {}

  @Post('material-lot-batches')
  @Contract('POST /logistics/material-lot-batches')
  create(@Req() request: Request, @Body() body: MaterialLotBatchCreate): Promise<MaterialLotBatchCreated> {
    const actor = materialLotWriteActorOf(request, 'POST /logistics/material-lot-batches');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.batches.create(body, actor));
  }

  @Get('material-lot-batches')
  @Contract('GET /logistics/material-lot-batches')
  list(@Req() request: Request, @Query() query: MaterialLotBatchQuery): Promise<PagedResponse<MaterialLotBatchRowView>> {
    return this.queries.list({ ...query, plantId: plantOf(request, query.plantId) });
  }

  @Get('waiting-material-lots')
  @Contract('GET /logistics/waiting-material-lots')
  waiting(@Req() request: Request, @Query() query: WaitingMaterialLotQuery): Promise<{ items: WaitingMaterialLotGroupView[] }> {
    return this.queries.waiting({ ...query, plantId: plantOf(request, query.plantId) });
  }

  /** 왼쪽 공급사·품목(피처 014 FR-010·011) — 만들지 않는다. */
  @Get('material-lot-pairs')
  @Contract('GET /logistics/material-lot-pairs')
  pairs(@Req() request: Request, @Query() query: MaterialLotPairQuery) {
    return this.pairList.pairs({ ...query, plantId: plantOf(request, query.plantId) });
  }

  /** 오른쪽 탭 — 「미출력」은 그 쪽까지 모자란 P/O 몫을 만든다(같은 요청 반복 = 같은 결과). */
  @Get('material-lots')
  @Contract('GET /logistics/material-lots')
  lots(@Req() request: Request, @Query() query: MaterialLotTabQuery) {
    return this.tabs.lots({
      ...query, plantId: plantOf(request, query.plantId), supplierId: Number(query.supplierId), itemId: Number(query.itemId),
    }, readActorOf(request));
  }

  @Get('material-lots/lookup')
  @Contract('GET /logistics/material-lots/lookup')
  lookup(@Req() request: Request, @Query() query: { plantId: number; lotNo: string }) {
    return this.pairList.lookup(plantOf(request, query.plantId), query.lotNo);
  }
}

/** 조회가 만든다(피처 014) — 단말이면 POP(작업자 없음), 계정이면 WEB. */
function readActorOf(request: Request): MaterialLotBatchActor {
  if (currentTerminal(request) !== undefined) return { channel: 'POP', workerId: null, terminalAudit: null };
  const session = currentSession(request);
  if (!session) throw new UnauthorizedException('세션이 필요합니다.');
  return { channel: 'WEB', appUserId: session.userId };
}

/** 단말은 자기 공장만 — 범위 검사가 다른 공장 `plantId` 를 이미 막았다. */
function plantOf(request: Request, plantId: number): number {
  const terminal = currentTerminal(request);
  return terminal === undefined ? Number(plantId) : Number(terminal.plantId);
}
