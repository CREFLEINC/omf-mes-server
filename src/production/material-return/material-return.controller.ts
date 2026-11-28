import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { materialReturnActorOf } from '../../auth/terminal-material-return-scope';
import { Contract } from '../../common/contract';
import type { PagedResponse } from '../../common/pagination';
import {
  MaterialReturnListQuery, MaterialReturnLocationLookup, MaterialReturnLotLookup, MaterialReturnQueryService, MaterialReturnWorkOrder, MaterialReturnWorkOrderLot,
} from './material-return-query.service';
import { MaterialReturnView } from './material-return-view';
import { MaterialReturnReceive, MaterialReturnService } from './material-return.service';

const RECEIVE = 'POST /production/material-returns';

/**
 * 반납 — 옛 조회 2건(I-10 · ETag·403 미선언)과 반납 입고(피처 019 · omf-all-around#367 · POP P-01-03 · PDA M-01-15).
 * 단말은 단말 공장으로 고정한다. POP 은 단말 공정 매핑 「반납 가능」이 켜진 단말만 온다(`terminal-material-return-scope.ts`).
 * ⛔ 취소·상태 전이 경로가 없다(FR-009). ⛔ 고정 경로(`lot-lookup`·`location-lookup`·`work-orders`)를 `:materialReturnId` 보다 먼저 둔다.
 */
@Controller('production/material-returns')
export class MaterialReturnController {
  constructor(
    private readonly queries: MaterialReturnQueryService,
    private readonly returns: MaterialReturnService,
  ) {}

  @Get()
  @Contract('GET /production/material-returns')
  list(@Query() query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    return this.queries.list(query);
  }

  @Get('lot-lookup')
  @Contract('GET /production/material-returns/lot-lookup')
  lotLookup(@Req() request: Request, @Query('lotNo') lotNo: string): Promise<MaterialReturnLotLookup> {
    return this.queries.lotLookup(lotNo, terminalPlant(request));
  }

  /** 받는 위치 스캔(PDA) — 단말은 단말 공장 위치만, 생산창고 위치만 받는다(출고 창고와 달라도 된다). */
  @Get('location-lookup')
  @Contract('GET /production/material-returns/location-lookup')
  locationLookup(@Req() request: Request, @Query('locationCode') locationCode: string): Promise<MaterialReturnLocationLookup> {
    return this.queries.locationLookup(locationCode, terminalPlant(request));
  }

  /** W/O 로 찾기 목록(§2) — 단말은 단말 공장, 계정은 질의 `plantId`(없으면 모든 공장). */
  @Get('work-orders')
  @Contract('GET /production/material-returns/work-orders')
  workOrders(
    @Req() request: Request, @Query() query: { q?: string; plantId?: number; page?: number; size?: number },
  ): Promise<PagedResponse<MaterialReturnWorkOrder>> {
    const plantId = terminalPlant(request) ?? (query.plantId === undefined ? null : BigInt(query.plantId));
    return this.queries.workOrders(plantId, query);
  }

  @Get('work-orders/:workOrderId/lots')
  @Contract('GET /production/material-returns/work-orders/{workOrderId}/lots')
  workOrderLots(@Req() request: Request, @Param('workOrderId', ParseIntPipe) workOrderId: number): Promise<{ items: MaterialReturnWorkOrderLot[] }> {
    return this.queries.workOrderLots(terminalPlant(request), workOrderId);
  }

  @Get(':materialReturnId')
  @Contract('GET /production/material-returns/{materialReturnId}')
  detail(@Param('materialReturnId', ParseIntPipe) materialReturnId: number): Promise<MaterialReturnView> {
    return this.queries.detail(materialReturnId);
  }

  /** 반납 입고. 멱등은 서비스가 번호를 트랜잭션 밖에서 뽑으며 직접 건다(적치 009 와 같다). ETag 없음. */
  @Post()
  @Contract(RECEIVE)
  receive(@Req() request: Request, @Body() body: MaterialReturnReceive): Promise<MaterialReturnView> {
    return this.returns.receive(request, body, materialReturnActorOf(request, RECEIVE), terminalPlant(request));
  }
}

/** 단말이면 단말 공장, 계정 세션이면 공장을 거르지 않는다(LOT 의 공장 그대로). */
function terminalPlant(request: Request): bigint | null {
  return currentTerminal(request)?.plantId ?? null;
}
