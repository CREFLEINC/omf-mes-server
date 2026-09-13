import { currentTerminal } from '../../auth/terminal-context';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { AllocationPackingService, ShipmentLotAllocationPacking } from './allocation-packing.service';
import {
  ShipmentAllocationFilters,
  ShipmentAllocationListResponse,
  ShipmentAllocationQueryService,
} from './shipment-allocation-query.service';
import { ShipmentLotAllocationView } from './shipment-allocation-view';

/**
 * MES 출하 LOT 배분 — 화면 `P-04-01`(납품라벨↔LOT 매칭 스캔) · `P-04-02`(발행 대상 목록).
 * ⛔ 등록 경로가 없다(계약 명시) — 배분은 출하 처리(I-23)가 만든다. 조회 하나 + 포장 연결 하나다.
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회는 403 미선언이라 더해도 죽은 행이고,
 * PUT 은 `DERIVED_PERMISSIONS:265`(`P-04-01`)가 이미 갖고 있다(§7-4).
 */
@Controller('logistics/shipment-lot-allocations')
export class ShipmentAllocationController {
  constructor(
    private readonly queries: ShipmentAllocationQueryService,
    private readonly packing: AllocationPackingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipment-lot-allocations')
  list(@Req() request: Request, @Query() query: ShipmentAllocationFilters): Promise<ShipmentAllocationListResponse> {
    return this.queries.list(query, currentTerminal(request)?.plantId);
  }

  /**
   * 포장 확정(`P-04-01` §4-C). Nest 의 `@Put` 기본 상태가 200 이라 `@HttpCode` 가 필요 없다.
   * ⛔ `If-Match`·ETag 를 안 쓴다 — `shipment_lot_allocation` 에 `version_no` 가 없다(계약 명시).
   * ⛔ 헤더는 계약 검증 가드가 «안 본다» — `X-Worker-No` 필수 판정은 서비스 몫이다.
   * ⛔ 409 봉투가 계열(`code` required)이라 계열 코드 인자를 넘긴다 — 안 넘기면 멱등 충돌 409 에서
   *   required 칸이 빠지고, e2e 로는 반증되지 않아 `family-conflict-code.spec.ts` 가 유일한 그물이다.
   * ⚠ 그 spec 은 `@Contract` 사이를 한 구간으로 세니 **이 주석에 그 상수 «이름»을 쓰면 안 된다** —
   *   위 `@Get` 구간으로 새어 「계열이 아닌데 넘겼다」가 된다(실제로 한 번 빨갰다).
   */
  @Put(':shipmentLotAllocationId')
  @Contract('PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}')
  pack(
    @Req() request: Request,
    @Param('shipmentLotAllocationId', ParseIntPipe) shipmentLotAllocationId: number,
    @Body() body: ShipmentLotAllocationPacking,
  ): Promise<ShipmentLotAllocationView> {
    const workerNo = request.headers['x-worker-no'];
    const actor = logisticsWriteActorOf(request, 'PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}');
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () =>
        this.packing.pack(shipmentLotAllocationId, body, {
          workerNo: typeof workerNo === 'string' ? workerNo : undefined,
          actor,
        }),
      FAMILY_CONFLICT_CODE,
    );
  }
}
