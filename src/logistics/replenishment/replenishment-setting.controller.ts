import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { userOf } from './replenishment-item.controller';
import { ReplenishmentSettingService, ReplenishmentWarehouseSettingUpdate } from './replenishment-setting.service';

/** 생산 창고 보충 — 자동 보충 실행 시각(W-02-12 · 피처 004). 공장 기본 시각은 운영 정책 경로로 저장한다. */
@Controller('logistics/replenishment-settings')
export class ReplenishmentSettingController {
  constructor(
    private readonly settings: ReplenishmentSettingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/replenishment-settings')
  get(@Query('plantId', ParseIntPipe) plantId: number) {
    return this.settings.get(plantId);
  }

  @Put('warehouses/:warehouseId')
  @Contract('PUT /logistics/replenishment-settings/warehouses/{warehouseId}')
  update(
    @Req() request: Request,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Body() body: ReplenishmentWarehouseSettingUpdate,
  ) {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.settings.update(tx, warehouseId, body, appUserId));
  }
}
