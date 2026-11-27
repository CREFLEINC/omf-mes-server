import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion } from '../../common/optimistic-lock';
import { currentTerminal } from '../../auth/terminal-context';
import { ShipmentCompletionBody, ShipmentCompletionResult, ShipmentCompletionService } from './shipment-completion.service';
import { ShipmentRequestCompletionView } from './shipment-completion-view';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { ShipmentLotManagementCode, ShipmentLotCodeService } from './shipment-lot-code.service';
import { ShipmentLotPick, ShipmentLotPickResult, ShipmentLotPickService } from './shipment-lot-pick.service';
import { ShipmentLotReplaceResult, ShipmentLotReplaceService } from './shipment-lot-replace.service';
import { TerminalShipmentScope } from './shipment-request-scope';
import { ShipmentRequestLotView } from './shipment-request-view';

const PICK_LOT = 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot';
const REPLACE = 'POST /logistics/shipment-request-lots/{shipmentRequestLotId}:replace';
const MANAGEMENT_CODE = 'PUT /logistics/shipment-request-lots/{shipmentRequestLotId}/management-code';
const COMPLETE = 'POST /logistics/shipment-requests/{shipmentRequestId}:complete';

/**
 * 출하 지시서 피킹 LOT(피처 010 · omf-all-around#305) — PDA LOT 통째 피킹.
 * ⛔ 409 봉투가 계열(`ShipmentConflictResponse`)이라 `FAMILY_CONFLICT_CODE` 를 넘긴다(`family-conflict-code.spec.ts`).
 */
/** 단말 범위(공장·창고) — 피킹 줄 고르기가 이 범위 안 줄만 본다(피처 012 R-2). 세션 호출은 없다. */
function terminalScopeOf(request: Request): TerminalShipmentScope | undefined {
  const terminal = currentTerminal(request);
  return terminal === undefined ? undefined : { plantId: terminal.plantId, warehouseId: terminal.warehouseId ?? null };
}

@Controller('logistics')
export class ShipmentRequestLotController {
  constructor(
    private readonly picks: ShipmentLotPickService,
    private readonly replaces: ShipmentLotReplaceService,
    private readonly codes: ShipmentLotCodeService,
    private readonly completions: ShipmentCompletionService,
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
      () => this.picks.pickLot(shipmentRequestId, shipmentRequestLineId, body, logisticsWriteActorOf(request, PICK_LOT), terminalScopeOf(request)),
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

  /**
   * 지시서 코드(`SHPREQ:{no}`) 해석 + 출하 완료 확인 값(POP P-04-07 · PDA 코드 보기). 단말이면 그 공장 지시서만.
   * ⛔ `shipment-requests/:id` 와 다른 경로 조각(`shipment-requests:lookup`)이라 겹치지 않는다.
   */
  @Get('shipment-requests\\:lookup')
  @Contract('GET /logistics/shipment-requests:lookup')
  lookup(@Req() request: Request, @Query('code') code: string | undefined): Promise<ShipmentRequestCompletionView> {
    return this.completions.lookup(code, currentTerminal(request)?.plantId);
  }

  /** 출하 완료 — POP 전용. `If-Match` 는 확인 화면이 받은 지시서 판(선택). */
  @Post('shipment-requests/:shipmentRequestId\\:complete')
  @Contract('POST /logistics/shipment-requests/{shipmentRequestId}:complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Req() request: Request,
    @Param('shipmentRequestId', ParseIntPipe) shipmentRequestId: number,
    @Body() body: ShipmentCompletionBody,
  ): Promise<ShipmentCompletionResult> {
    return runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.completions.complete(shipmentRequestId, body, ifMatchVersion(request), logisticsWriteActorOf(request, COMPLETE)),
      FAMILY_CONFLICT_CODE,
    );
  }
}
