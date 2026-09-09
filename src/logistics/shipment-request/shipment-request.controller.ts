import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  ShipmentRequestQueryService,
  ShipmentRequestSummaryView,
} from './shipment-request-query.service';
import { ShipmentRequestFilters, ShipmentRequestQuery } from './shipment-request-query.sql';
import { ShipmentRequestView } from './shipment-request-view';

/**
 * MES 출하작업지시 — 화면 `W-04-01`(편성) · `W-04-02`(목록·요약·상세) · `M-04-01`(피킹).
 *
 * ⚠ 지금은 조회 셋뿐이다 — 편성 POST(PR ⑤) · `:pick`(⑥)이 **같은 파일에** 더해진다.
 * 계약이 한 자원 아래 묶어 둔 5건이라 컨트롤러를 가르지 않는다(§7-3).
 * ⛔ 403 을 선언하지 않은 오퍼레이션이라 `OPERATION_PERMISSIONS` 에 아무것도 더하지 않는다 —
 * 더해도 `permission.guard.ts` 가 영영 안 읽는 죽은 행이 된다(§7-4).
 */
@Controller('logistics/shipment-requests')
export class ShipmentRequestController {
  constructor(private readonly queries: ShipmentRequestQueryService) {}

  @Get()
  @Contract('GET /logistics/shipment-requests')
  list(@Query() query: ShipmentRequestQuery): Promise<PagedResponse<ShipmentRequestView>> {
    return this.queries.list(query);
  }

  /**
   * ⛔⛔ **`@Get(':shipmentRequestId')` «앞»에 있어야 한다.** Nest 는 선언 순서대로 라우트를
   * 등록하고 Express 가 먼저 맞는 것을 잡는다 — 뒤에 두면 `summary` 가 경로 파라미터로 잡혀
   * `{field:'shipmentRequestId', code:'INVALID', message:'must be integer'}` 400 이 나간다
   * (PR ③b 에서 실제로 그랬다). e2e L-53 이 이 순서를 잠근다. ⛔ 아래로 옮기지 마라.
   */
  @Get('summary')
  @Contract('GET /logistics/shipment-requests/summary')
  summary(@Query() query: ShipmentRequestFilters): Promise<ShipmentRequestSummaryView> {
    return this.queries.summary(query);
  }

  @Get(':shipmentRequestId')
  @Contract('GET /logistics/shipment-requests/{shipmentRequestId}')
  get(
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
  ): Promise<ShipmentRequestView> {
    return this.queries.get(shipmentRequestId);
  }
}
