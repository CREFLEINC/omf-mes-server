import { Body, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { ShipmentLotManagementCode, ShipmentLotCodeService } from './shipment-lot-code.service';
import { ShipmentLotPick, ShipmentLotPickResult, ShipmentLotPickService } from './shipment-lot-pick.service';
import { ShipmentLotReplaceResult, ShipmentLotReplaceService } from './shipment-lot-replace.service';
import { ShipmentRequestLotView } from './shipment-request-view';

const PICK_LOT = 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot';
const REPLACE = 'POST /logistics/shipment-request-lots/{shipmentRequestLotId}:replace';
const MANAGEMENT_CODE = 'PUT /logistics/shipment-request-lots/{shipmentRequestLotId}/management-code';

/**
 * 출하 지시서 피킹 LOT(피처 010 · omf-all-around#305) — PDA LOT 통째 피킹.
 * ⛔ 409 봉투가 계열(`ShipmentConflictResponse`)이라 `FAMILY_CONFLICT_CODE` 를 넘긴다(`family-conflict-code.spec.ts`).
 */
@Controller('logistics')
export class ShipmentRequestLotController {
  constructor(
    private readonly picks: ShipmentLotPickService,
    private readonly replaces: ShipmentLotReplaceService,
    private readonly codes: ShipmentLotCodeService,
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

  /** OQC 불합격 피킹 LOT 교체(PDA [교체]) — 본문 없음. */
  @Post('shipment-request-lots/:shipmentRequestLotId\\:replace')
  @Contract('POST /logistics/shipment-request-lots/{shipmentRequestLotId}:replace')
  @HttpCode(HttpStatus.OK)
  replace(
    @Req() request: Request,
    @Param('shipmentRequestLotId', ParseIntPipe) shipmentRequestLotId: number,
  ): Promise<ShipmentLotReplaceResult> {
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.replaces.replace(shipmentRequestLotId, logisticsWriteActorOf(request, REPLACE)),
      FAMILY_CONFLICT_CODE,
    );
  }

  /** 출하 관리 코드(스캔·직접 입력) — PICKED 일 때만. */
  @Put('shipment-request-lots/:shipmentRequestLotId/management-code')
  @Contract('PUT /logistics/shipment-request-lots/{shipmentRequestLotId}/management-code')
  saveManagementCode(
    @Req() request: Request,
    @Param('shipmentRequestLotId', ParseIntPipe) shipmentRequestLotId: number,
    @Body() body: ShipmentLotManagementCode,
  ): Promise<ShipmentRequestLotView> {
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.codes.save(shipmentRequestLotId, body, logisticsWriteActorOf(request, MANAGEMENT_CODE)),
      FAMILY_CONFLICT_CODE,
    );
  }
}
