import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { logisticsWriteActorOf } from '../logistics-write-actor';
import { ShippingUnitAddBox, ShippingUnitBoxService } from './shipping-unit-box.service';
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
    private readonly boxes: ShippingUnitBoxService,
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

  /**
   * 포장 라벨 스캔으로 상자를 넣는다. ⭐ 같은 상자를 다시 스캔하면 200 이고 아무것도
   * 바뀌지 않는다 — 스캐너가 한 번에 두 번 읽는 일이 흔하다.
   * ⚠ `handlingUnitNo`(번호)로 받는다 — 스캐너가 주는 값이 id 가 아니라 그것이다.
   */
  // ⛔ Nest 의 `@Post` 기본 상태는 201 이다 — 이 경로는 «만들지» 않고 구성만 바꾸므로 200 이다.
  @HttpCode(HttpStatus.OK)
  @Post(':shippingUnitId\\:add-box')
  @Contract('POST /logistics/shipping-units/{shippingUnitId}:add-box')
  async addBox(
    @Req() request: Request,
    @Param('shippingUnitId', ParseIntPipe) shippingUnitId: number,
    @Body() body: ShippingUnitAddBox,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShippingUnitDetailView> {
    const actor = logisticsWriteActorOf(request, 'POST /logistics/shipping-units/{shippingUnitId}:add-box');
    const detail = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.boxes.addBox(shippingUnitId, body, {
        appUserId: actor.appUserId,
        plantId: currentTerminal(request)?.plantId,
      }),
    );
    setEtag(response, detail.versionNo);
    return detail;
  }

  /** ⛔ 204 가 아니라 200 + 상세다 — 화면이 상자 목록과 품목별 합계를 그 자리에서 다시 그린다. */
  @Delete(':shippingUnitId/boxes/:handlingUnitId')
  @Contract('DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}')
  async removeBox(
    @Req() request: Request,
    @Param('shippingUnitId', ParseIntPipe) shippingUnitId: number,
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShippingUnitDetailView> {
    const actor = logisticsWriteActorOf(
      request,
      'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}',
    );
    const detail = await this.boxes.removeBox(shippingUnitId, handlingUnitId, {
      appUserId: actor.appUserId,
      plantId: currentTerminal(request)?.plantId,
    });
    setEtag(response, detail.versionNo);
    return detail;
  }

  /** 마감. ⛔ 되돌릴 수 없다 — 취소·해체 경로를 두지 않는다(통보 142 와 같은 태도). */
  @HttpCode(HttpStatus.OK)
  @Post(':shippingUnitId\\:close')
  @Contract('POST /logistics/shipping-units/{shippingUnitId}:close')
  async close(
    @Req() request: Request,
    @Param('shippingUnitId', ParseIntPipe) shippingUnitId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShippingUnitDetailView> {
    const actor = logisticsWriteActorOf(request, 'POST /logistics/shipping-units/{shippingUnitId}:close');
    const expected = ifMatchVersion(request);
    // 계약이 `If-Match` 를 required 로 걸어 가드가 이미 400 을 냈다 — 여기까지 왔는데 없으면
    // 계약 선언과 가드가 어긋난 것이다(선례: `document-progress.controller.ts`).
    if (expected === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }
    const detail = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.boxes.close(shippingUnitId, expected, {
        appUserId: actor.appUserId,
        plantId: currentTerminal(request)?.plantId,
      }),
      // ⛔ 이 경로의 409 봉투는 계열이라 `code` 가 required 다 — 안 넘기면 멱등 충돌 409 에서
      //    그 칸이 빠진다. e2e 로는 반증되지 않아 `family-conflict-code.spec.ts` 가 유일한 그물이다.
      FAMILY_CONFLICT_CODE,
    );
    setEtag(response, detail.versionNo);
    return detail;
  }
}
