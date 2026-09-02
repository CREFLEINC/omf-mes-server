import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  SparePartCreate,
  SparePartQuery,
  SparePartService,
  SparePartUpdate,
} from './spare-part.service';

/** 예비품 마스터. 화면은 `W-06-08` 이다. */
@Controller('mdm/spare-parts')
export class SparePartController {
  constructor(
    private readonly spareParts: SparePartService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/spare-parts')
  list(@Query() query: SparePartQuery): Promise<PagedResponse<unknown>> {
    return this.spareParts.list(query);
  }

  @Get(':sparePartId')
  @Contract('GET /mdm/spare-parts/{sparePartId}')
  async get(
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { sparePart, editability, mappedEquipmentCount, versionNo } =
      await this.spareParts.get(sparePartId);
    setEtag(response, versionNo);
    return { sparePart, editability, mappedEquipmentCount };
  }

  @Post()
  @Contract('POST /mdm/spare-parts')
  create(@Req() request: Request, @Body() body: SparePartCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.spareParts.create(body),
    );
  }

  @Put(':sparePartId')
  @Contract('PUT /mdm/spare-parts/{sparePartId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
    @Body() body: SparePartUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'sparePart', (version) =>
      this.spareParts.update(sparePartId, version, body),
    );
  }

  @Post(':sparePartId\\:activate')
  @Contract('POST /mdm/spare-parts/{sparePartId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'sparePart', (version) =>
      this.spareParts.setActive(sparePartId, version, true),
    );
  }

  @Post(':sparePartId\\:deactivate')
  @Contract('POST /mdm/spare-parts/{sparePartId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'sparePart', (version) =>
      this.spareParts.setActive(sparePartId, version, false),
    );
  }

  @Get(':sparePartId/equipments')
  @Contract('GET /mdm/spare-parts/{sparePartId}/equipments')
  async listMappings(
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { items, versionNo } = await this.spareParts.listMappings(sparePartId);
    setEtag(response, versionNo);
    return { items };
  }

  @Put(':sparePartId/equipments')
  @Contract('PUT /mdm/spare-parts/{sparePartId}/equipments')
  async replaceMappings(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sparePartId', ParseIntPipe) sparePartId: number,
    @Body() body: { equipmentIds: number[] },
  ): Promise<unknown> {
    const items = await runVersioned(this.idempotency, request, response, 'items', (version) =>
      this.spareParts.replaceMappings(
        sparePartId,
        version,
        body.equipmentIds,
        currentSession(request)?.userId,
      ),
    );
    return { items };
  }
}
