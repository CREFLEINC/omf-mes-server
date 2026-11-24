import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { BackwardEndRow, BackwardSummary } from './backward-end-rows';
import { ForwardEndRow, ForwardSummary } from './forward-end-rows';
import { TraceLotPage, TraceLotQuery, TraceLotsService } from './trace-lots.service';
import { TraceStartMatch, TraceStartQuery, TraceStartsService } from './trace-starts.service';
import { RootShipment, TraceGraph, TraceTreeQuery, TraceTreeService } from './trace-tree.service';

/**
 * 자재 기준 생산 추적(W-02-13)·제품 기준 역추적(W-02-14) — 피처 015 · omf-all-around#355. 관리웹 세션 전용이다.
 * 목록 둘·번호 풀기·계보 둘·내보내기 둘(contracts §1~§5).
 */
@Controller('trace')
export class TraceTreeController {
  constructor(
    private readonly lots: TraceLotsService,
    private readonly starts: TraceStartsService,
    private readonly trees: TraceTreeService,
  ) {}

  @Get('material-trace-lots')
  @Contract('GET /trace/material-trace-lots')
  materialLots(@Query() query: TraceLotQuery): Promise<TraceLotPage> {
    return this.lots.materials(query);
  }

  @Get('product-trace-lots')
  @Contract('GET /trace/product-trace-lots')
  productLots(@Query() query: TraceLotQuery): Promise<TraceLotPage> {
    return this.lots.products(query);
  }

  @Get('trace-starts')
  @Contract('GET /trace/trace-starts')
  traceStarts(@Query() query: TraceStartQuery, @Req() request: Request): Promise<{ matches: TraceStartMatch[] }> {
    return this.starts.resolve(query, currentSession(request)?.permissions ?? []);
  }

  @Get('forward-tree')
  @Contract('GET /trace/forward-tree')
  forwardTree(@Query() query: TraceTreeQuery): Promise<TraceGraph & { endRows: ForwardEndRow[]; summary: ForwardSummary }> {
    return this.trees.forward(query);
  }

  @Get('backward-tree')
  @Contract('GET /trace/backward-tree')
  backwardTree(@Query() query: TraceTreeQuery): Promise<TraceGraph & { endRows: BackwardEndRow[]; summary: BackwardSummary; rootShipments: RootShipment[] }> {
    return this.trees.backward(query);
  }
}
