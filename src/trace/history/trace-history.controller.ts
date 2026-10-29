import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedWithTotals } from '../../logistics/line-list';
import { MaterialInputLineListItem, MaterialInputLineListQuery, MaterialInputLineListService } from './material-input-line-list.service';
import { PackingLineListItem, PackingLineListQuery, PackingLineListService } from './packing-line-list.service';

/** LOT 생산 이력 조회(W-02-09)의 기간별 이력 중 투입과 포장(장부 P-151). 입고·출하는 입고 줄·출하 줄 현황이 낸다. 관리웹 세션 전용이다. */
@Controller('trace')
export class TraceHistoryController {
  constructor(
    private readonly inputs: MaterialInputLineListService,
    private readonly packings: PackingLineListService,
  ) {}

  @Get('material-input-lines')
  @Contract('GET /trace/material-input-lines')
  materialInputs(@Query() query: MaterialInputLineListQuery): Promise<PagedWithTotals<MaterialInputLineListItem>> {
    return this.inputs.list(query);
  }

  @Get('packing-lines')
  @Contract('GET /trace/packing-lines')
  packingLines(@Query() query: PackingLineListQuery): Promise<PagedWithTotals<PackingLineListItem>> {
    return this.packings.list(query);
  }
}
