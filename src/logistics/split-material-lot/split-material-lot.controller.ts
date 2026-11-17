import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { SplitMaterialLotList, SplitMaterialLotQuery, SplitMaterialLotQueryService } from './split-material-lot-query.service';

/** 분할 LOT 라벨 목록(POP P-01-02 · 피처 008). */
@Controller('logistics/split-material-lots')
export class SplitMaterialLotController {
  constructor(private readonly queries: SplitMaterialLotQueryService) {}

  @Get()
  @Contract('GET /logistics/split-material-lots')
  list(@Req() request: Request, @Query() query: SplitMaterialLotQuery): Promise<SplitMaterialLotList> {
    // 단말은 자기 공장만 — 범위 검사가 다른 공장 `plantId` 를 이미 막았다.
    const terminal = currentTerminal(request);
    return this.queries.list({ ...query, plantId: terminal === undefined ? Number(query.plantId) : Number(terminal.plantId) });
  }
}
