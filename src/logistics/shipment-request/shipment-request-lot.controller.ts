import { Body, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { ShipmentLotPick, ShipmentLotPickResult, ShipmentLotPickService } from './shipment-lot-pick.service';

const PICK_LOT = 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot';

/**
 * 출하 지시서 피킹 LOT(피처 010 · omf-all-around#305) — PDA LOT 통째 피킹.
 * ⛔ 409 봉투가 계열(`ShipmentConflictResponse`)이라 `FAMILY_CONFLICT_CODE` 를 넘긴다(`family-conflict-code.spec.ts`).
 */
@Controller('logistics')
export class ShipmentRequestLotController {
  constructor(
    private readonly picks: ShipmentLotPickService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('shipment-requests/:shipmentRequestId/lines/:shipmentRequestLineId\\:pick-lot')
  @Contract('POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot')
  @HttpCode(HttpStatus.OK)
  pickLot(
    @Req() request: Request,
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
    @Param('shipmentRequestLineId', ParseIntPipe) shipmentRequestLineId: number,
    @Body() body: ShipmentLotPick,
  ): Promise<ShipmentLotPickResult> {
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.picks.pickLot(shipmentRequestId, shipmentRequestLineId, body, logisticsWriteActorOf(request, PICK_LOT)),
      FAMILY_CONFLICT_CODE,
    );
  }
}
