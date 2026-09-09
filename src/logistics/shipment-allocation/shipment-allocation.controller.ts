import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import {
  ShipmentAllocationFilters,
  ShipmentAllocationListResponse,
  ShipmentAllocationQueryService,
} from './shipment-allocation-query.service';

/**
 * MES 출하 LOT 배분 — 화면 `P-04-01`(납품라벨↔LOT 매칭 스캔) · `P-04-02`(발행 대상 목록).
 * ⛔ 등록 경로가 없다(계약 명시) — 배분은 출하 처리(I-23)가 만든다. 이 조회 하나뿐이다.
 * ⛔ 403 미선언 — `OPERATION_PERMISSIONS` 에 아무것도 더하지 않는다(§7-4).
 */
@Controller('logistics/shipment-lot-allocations')
export class ShipmentAllocationController {
  constructor(private readonly queries: ShipmentAllocationQueryService) {}

  @Get()
  @Contract('GET /logistics/shipment-lot-allocations')
  list(@Query() query: ShipmentAllocationFilters): Promise<ShipmentAllocationListResponse> {
    return this.queries.list(query);
  }
}
