import { Body, Controller, Get, Param, ParseIntPipe, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master-write';
import { setEtag } from '../../common/optimistic-lock';
import {
  BuItemMapInput,
  ExternalCodeInput,
  ItemDetailService,
  Replaced,
  UomConversionInput,
} from './item-detail.service';

/**
 * 품목 「부속 정보」 세 탭. 화면은 `W-06-05` 로 품목 본체와 같지만, 저장 단위가 탭마다
 * 통째 교체라 본체 컨트롤러와 갈랐다.
 */
@Controller('mdm/items')
export class ItemDetailController {
  constructor(
    private readonly details: ItemDetailService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':itemId/bu-item-maps')
  @Contract('GET /mdm/items/{itemId}/bu-item-maps')
  listBuItemMaps(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.list(response, this.details.listBuItemMaps(itemId));
  }

  @Put(':itemId/bu-item-maps')
  @Contract('PUT /mdm/items/{itemId}/bu-item-maps')
  replaceBuItemMaps(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: { maps: BuItemMapInput[] },
  ): Promise<unknown> {
    return this.replace(request, response, (version) =>
      this.details.replaceBuItemMaps(itemId, version, body.maps, currentSession(request)?.userId),
    );
  }

  @Get(':itemId/external-codes')
  @Contract('GET /mdm/items/{itemId}/external-codes')
  listExternalCodes(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.list(response, this.details.listExternalCodes(itemId));
  }

  @Put(':itemId/external-codes')
  @Contract('PUT /mdm/items/{itemId}/external-codes')
  replaceExternalCodes(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: { externalCodes: ExternalCodeInput[] },
  ): Promise<unknown> {
    return this.replace(request, response, (version) =>
      this.details.replaceExternalCodes(
        itemId,
        version,
        body.externalCodes,
        currentSession(request)?.userId,
      ),
    );
  }

  @Get(':itemId/uom-conversions')
  @Contract('GET /mdm/items/{itemId}/uom-conversions')
  listUomConversions(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.list(response, this.details.listUomConversions(itemId));
  }

  @Put(':itemId/uom-conversions')
  @Contract('PUT /mdm/items/{itemId}/uom-conversions')
  replaceUomConversions(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: { conversions: UomConversionInput[] },
  ): Promise<unknown> {
    return this.replace(request, response, (version) =>
      this.details.replaceUomConversions(
        itemId,
        version,
        body.conversions,
        currentSession(request)?.userId,
      ),
    );
  }

  // ── 공통 ────────────────────────────────────────────────────────────────

  /** 세 탭의 조회가 같다 — 목록을 내고 품목 버전을 ETag 로 붙인다. */
  private async list<T>(response: Response, work: Promise<Replaced<T>>): Promise<unknown> {
    const { items, versionNo } = await work;
    setEtag(response, versionNo);
    return { items };
  }

  private async replace<T>(
    request: Request,
    response: Response,
    work: (version: number) => Promise<Replaced<T>>,
  ): Promise<unknown> {
    const items = await runVersioned(this.idempotency, request, response, 'items', work);
    return { items };
  }
}
