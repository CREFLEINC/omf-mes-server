import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { ShippingUnitFilters, ShippingUnitQueryService } from './shipping-unit-query.service';
import { ShippingUnitCreate, ShippingUnitService } from './shipping-unit.service';
import { ShippingUnitDetailView, ShippingUnitView } from './shipping-unit-view';

/**
 * 출하 단위 — 화면 `P-04-05`(출하 단위 구성).
 *
 * 상자(취급 단위)를 묶어 내보내는 단위이고, **납품 라벨 한 장이 이 단위 하나에 붙는다.**
 * 종전에는 출하 LOT 배분이 그 주인이라 상자 하나에 라벨이 여러 장 나왔다.
 *
 * ⛔ **계약 사본에 우리가 먼저 적은 경로다**(장부 P-24) — 설계팀 정본에는 아직 없다.
 *    사본이 당겨져 이 규격이 사라지면 `contract-shipping-unit.spec.ts` 가 빨개진다.
 * ⭐ 세션(관리자 웹)과 **POP 단말** 둘 다 부른다. 단말이면 그 단말의 공장으로 범위가 좁혀진다
 *    — 단말은 자기 창고를 모르고, 좁히지 않으면 남의 공장 단위가 목록에 샌다.
 */
@Controller('logistics/shipping-units')
export class ShippingUnitController {
  constructor(
    private readonly queries: ShippingUnitQueryService,
    private readonly units: ShippingUnitService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/shipping-units')
  list(
    @Req() request: Request,
    @Query() query: ShippingUnitFilters,
  ): Promise<PagedResponse<ShippingUnitView>> {
    return this.queries.list(query, currentTerminal(request)?.plantId);
  }

  @Get(':shippingUnitId')
  @Contract('GET /logistics/shipping-units/{shippingUnitId}')
  async get(
    @Req() request: Request,
    @Param('shippingUnitId', ParseIntPipe) shippingUnitId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShippingUnitDetailView> {
    const detail = await this.queries.get(shippingUnitId, currentTerminal(request)?.plantId);
    // 마감(`:close`)이 `If-Match` 로 이 값을 되받는다.
    setEtag(response, detail.versionNo);
    return detail;
  }

  /**
   * 빈 단위를 연다. 상자는 `:add-box` 로 넣는다.
   * ⚠ 201 에 ETag 를 싣는다 — 만든 직후 상자를 넣고 바로 마감하는 흐름이라, 상세를 다시 읽지
   *   않고도 `If-Match` 를 쥘 수 있어야 한다.
   */
  @Post()
  @Contract('POST /logistics/shipping-units')
  async create(
    @Req() request: Request,
    @Body() body: ShippingUnitCreate,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShippingUnitDetailView> {
    const actor = logisticsWriteActorOf(request, 'POST /logistics/shipping-units');
    const detail = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.units.create(body, {
        appUserId: actor.appUserId,
        plantId: currentTerminal(request)?.plantId,
      }),
    );
    setEtag(response, detail.versionNo);
    return detail;
  }
}
