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

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  EquipmentCreate,
  EquipmentQuery,
  EquipmentService,
  EquipmentWrite,
} from './equipment.service';

/** 설비 마스터. 화면은 `W-05-12`(설비 마스터)·`W-05-11`(계측기)이 함께 쓴다. */
@Controller('mdm/equipments')
export class EquipmentController {
  constructor(
    private readonly equipments: EquipmentService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/equipments')
  list(@Query() query: EquipmentQuery): Promise<PagedResponse<unknown>> {
    return this.equipments.list(query);
  }

  @Get(':equipmentId')
  @Contract('GET /mdm/equipments/{equipmentId}')
  async get(
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { equipment, editability, hierarchy, versionNo } = await this.equipments.get(equipmentId);
    setEtag(response, versionNo);
    return { equipment, editability, hierarchy };
  }

  @Post()
  @Contract('POST /mdm/equipments')
  create(@Req() request: Request, @Body() body: EquipmentCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.equipments.create(body),
    );
  }

  @Put(':equipmentId')
  @Contract('PUT /mdm/equipments/{equipmentId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
    @Body() body: EquipmentWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipment', (version) =>
      this.equipments.update(equipmentId, version, body),
    );
  }

  @Post(':equipmentId\\:activate')
  @Contract('POST /mdm/equipments/{equipmentId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipment', (version) =>
      this.equipments.setActive(equipmentId, version, true),
    );
  }

  @Post(':equipmentId\\:deactivate')
  @Contract('POST /mdm/equipments/{equipmentId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipment', (version) =>
      this.equipments.setActive(equipmentId, version, false),
    );
  }

  @Post(':equipmentId\\:dispose')
  @Contract('POST /mdm/equipments/{equipmentId}:dispose')
  @HttpCode(HttpStatus.OK)
  dispose(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentId', ParseIntPipe) equipmentId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipment', (version) =>
      this.equipments.dispose(equipmentId, version),
    );
  }
}
