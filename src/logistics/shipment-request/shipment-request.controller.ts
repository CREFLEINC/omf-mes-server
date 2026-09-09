import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestView } from './shipment-request-view';

/**
 * MES 출하작업지시 — 화면 `W-04-01`(편성) · `W-04-02`(목록·상세) · `M-04-01`(피킹).
 *
 * ⚠ 지금은 단건 조회 하나뿐이다 — 목록·요약(PR ④) · 편성 POST(⑤) · `:pick`(⑥)이 **같은 파일에**
 * 더해진다. 계약이 한 자원 아래 묶어 둔 5건이라 컨트롤러를 가르지 않는다(§7-3).
 * ⛔ 403 을 선언하지 않은 오퍼레이션이라 `OPERATION_PERMISSIONS` 에 아무것도 더하지 않는다 —
 * 더해도 `permission.guard.ts` 가 영영 안 읽는 죽은 행이 된다(§7-4).
 */
@Controller('logistics/shipment-requests')
export class ShipmentRequestController {
  constructor(private readonly queries: ShipmentRequestQueryService) {}

  @Get(':shipmentRequestId')
  @Contract('GET /logistics/shipment-requests/{shipmentRequestId}')
  get(
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
  ): Promise<ShipmentRequestView> {
    return this.queries.get(shipmentRequestId);
  }
}
