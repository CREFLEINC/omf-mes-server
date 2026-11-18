import { Controller, Get, HttpStatus, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { PagedResponse } from '../../common/pagination';
import { PendingLotView } from './pending-lot-query';
import { LocationCheckView, PendingLotLookup, PendingLotQuery, PutawayDirectQueryService } from './putaway-direct.query.service';

/**
 * 적치 지시 없는 구매 입고 적치(피처 009 · omf-all-around#294) — 화면 M-01-05·M-01-07.
 * 단말은 단말 공장으로 고정한다(범위 검사가 다른 공장 `plantId` 를 이미 막았다).
 */
@Controller('logistics')
export class PutawayDirectController {
  constructor(private readonly queries: PutawayDirectQueryService) {}

  @Get('putaway-pending-lots')
  @Contract('GET /logistics/putaway-pending-lots')
  list(@Req() request: Request, @Query() query: PendingLotQuery): Promise<PagedResponse<PendingLotView>> {
    const plantId = plantOf(request, query.plantId);
    if (plantId === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field: 'plantId', code: ERROR_CODE.REQUIRED, message: '공장이 필요합니다.' }]);
    }
    return this.queries.list(plantId, query);
  }

  @Get('putaway-pending-lots\\:lookup')
  @Contract('GET /logistics/putaway-pending-lots:lookup')
  lookup(@Req() request: Request, @Query('lotNo') lotNo: string, @Query('plantId') plantId?: number): Promise<PendingLotLookup> {
    return this.queries.lookup(plantOf(request, plantId), lotNo);
  }

  @Get('putaway-pending-lots/:lotId/location-check')
  @Contract('GET /logistics/putaway-pending-lots/{lotId}/location-check')
  locationCheck(
    @Req() request: Request, @Param('lotId', ParseIntPipe) lotId: number, @Query('locationCode') locationCode: string,
  ): Promise<LocationCheckView> {
    return this.queries.locationCheck(plantOf(request, undefined), lotId, locationCode);
  }
}

/** 단말이면 단말 공장, 세션이면 질의 공장(없으면 `null` — LOT 의 공장을 그대로 본다). */
export function plantOf(request: Request, queryPlantId: number | undefined): bigint | null {
  const terminal = currentTerminal(request);
  if (terminal !== undefined) return terminal.plantId;
  return queryPlantId === undefined ? null : BigInt(queryPlantId);
}
