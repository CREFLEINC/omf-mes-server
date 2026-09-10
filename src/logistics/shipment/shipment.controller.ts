import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentQuery } from './shipment-query.sql';
import { ShipmentView } from './shipment-view';

/**
 * MES 출하 — 화면 `W-04-04`(처리·확정) · `W-04-12`(취소) · `W-04-02`(목록).
 *
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회는 403 을 «선언하지 않아» 더해도 죽은
 * 행이 되고, 403 을 선언한 다섯은 `DERIVED_PERMISSIONS` 가 **이미 갖고 있다**(§1-1 실측
 * `:68`·`:69`·`:182`~`:185`·`:187`). ⚠ 미등재였다면 가드가 던져 403 이 아니라 **500** 이다.
 * ⛔ `manual-permissions.ts` 에 더하면 `operation-permissions.spec.ts:27-37`(순수 중복 금지)이 빨개진다.
 */
@Controller('logistics/shipments')
export class ShipmentController {
  constructor(private readonly queries: ShipmentQueryService) {}

  @Get()
  @Contract('GET /logistics/shipments')
  list(@Query() query: ShipmentQuery): Promise<PagedResponse<ShipmentView>> {
    return this.queries.list(query);
  }
}
