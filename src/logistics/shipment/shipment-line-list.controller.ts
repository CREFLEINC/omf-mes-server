import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedWithTotals } from '../line-list';
import { ShipmentLineListItem, ShipmentLineListQuery, ShipmentLineListService } from './shipment-line-list.service';

/** 제품출고 현황 — LOT 추적 화면(장부 P-119). 관리웹 세션 전용이다. */
@Controller('logistics/shipment-lines')
export class ShipmentLineListController {
  constructor(private readonly lines: ShipmentLineListService) {}

  @Get()
  @Contract('GET /logistics/shipment-lines')
  list(@Query() query: ShipmentLineListQuery): Promise<PagedWithTotals<ShipmentLineListItem>> {
    return this.lines.list(query);
  }
}
