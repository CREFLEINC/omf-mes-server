import { Body, Controller, Get, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { BackwardEndRow, BackwardSummary } from './backward-end-rows';
import { ForwardEndRow, ForwardSummary } from './forward-end-rows';
import { TraceExportBody, TraceExportService } from './trace-export.service';
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
    private readonly exports: TraceExportService,
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

  /** 헤더를 쓰기 전에 모든 예외를 던진다 — 400·404·422 가 전역 필터의 ErrorResponse 로 나간다. */
  @Post('forward-exports')
  @Contract('POST /trace/forward-exports')
  async forwardExports(@Body() body: TraceExportBody, @Res() response: Response): Promise<void> {
    sendXlsx(response, await this.exports.build('FORWARD', body));
  }

  @Post('backward-exports')
  @Contract('POST /trace/backward-exports')
  async backwardExports(@Body() body: TraceExportBody, @Res() response: Response): Promise<void> {
    sendXlsx(response, await this.exports.build('BACKWARD', body));
  }
}

function sendXlsx(response: Response, file: { fileName: string; bytes: Buffer }): void {
  response.status(HttpStatus.OK);
  response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  response.setHeader('Cache-Control', 'private, no-store');
  response.end(file.bytes);
}
