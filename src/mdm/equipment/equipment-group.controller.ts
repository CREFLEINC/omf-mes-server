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
  EquipmentGroupCreate,
  EquipmentGroupQuery,
  EquipmentGroupService,
  EquipmentGroupUpdate,
} from './equipment-group.service';

/** 설비 그룹 마스터. 화면은 `W-05-12` §4-A·§5-1 이다. */
@Controller('mdm/equipment-groups')
export class EquipmentGroupController {
  constructor(
    private readonly groups: EquipmentGroupService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/equipment-groups')
  list(@Query() query: EquipmentGroupQuery): Promise<PagedResponse<unknown>> {
    return this.groups.list(query);
  }

  @Get(':equipmentGroupId')
  @Contract('GET /mdm/equipment-groups/{equipmentGroupId}')
  async get(
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { equipmentGroup, editability, memberEquipmentCount, versionNo } =
      await this.groups.get(equipmentGroupId);
    setEtag(response, versionNo);
    return { equipmentGroup, editability, memberEquipmentCount };
  }

  @Post()
  @Contract('POST /mdm/equipment-groups')
  create(@Req() request: Request, @Body() body: EquipmentGroupCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.groups.create(body),
    );
  }

  @Put(':equipmentGroupId')
  @Contract('PUT /mdm/equipment-groups/{equipmentGroupId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
    @Body() body: EquipmentGroupUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipmentGroup', (version) =>
      this.groups.update(equipmentGroupId, version, body),
    );
  }

  @Post(':equipmentGroupId\\:activate')
  @Contract('POST /mdm/equipment-groups/{equipmentGroupId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipmentGroup', (version) =>
      this.groups.setActive(equipmentGroupId, version, true),
    );
  }

  @Post(':equipmentGroupId\\:deactivate')
  @Contract('POST /mdm/equipment-groups/{equipmentGroupId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentGroupId', ParseIntPipe) equipmentGroupId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'equipmentGroup', (version) =>
      this.groups.setActive(equipmentGroupId, version, false),
    );
  }
}
