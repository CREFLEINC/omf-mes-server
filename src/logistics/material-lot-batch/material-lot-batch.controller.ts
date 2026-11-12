import { Body, Controller, Get, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { materialLotWriteActorOf } from '../../auth/terminal-material-lot-scope';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  MaterialLotBatchQuery,
  MaterialLotBatchQueryService,
  MaterialLotBatchRowView,
  WaitingMaterialLotGroupView,
  WaitingMaterialLotQuery,
} from './material-lot-batch-query.service';
import { MaterialLotBatchCreate, MaterialLotBatchCreated, MaterialLotBatchService } from './material-lot-batch.service';

/** 자재 관리 LOT 발행(POP P-01-01 · 웹 W-01-14) — 피처 005 §1. */
@Controller('logistics')
export class MaterialLotBatchController {
  constructor(
    private readonly batches: MaterialLotBatchService,
    private readonly queries: MaterialLotBatchQueryService,
    private readonly idempotency: IdempotencyService,
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
}

/** 단말은 자기 공장만 — 범위 검사가 다른 공장 `plantId` 를 이미 막았다. */
function plantOf(request: Request, plantId: number): number {
  const terminal = currentTerminal(request);
  return terminal === undefined ? Number(plantId) : Number(terminal.plantId);
}
