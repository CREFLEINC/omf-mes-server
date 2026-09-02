import {
  Body,
  Controller,
  Get,
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
import { runIdempotent, runVersioned } from '../../common/master-write';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  InspectionItemCreate,
  InspectionItemQuery,
  InspectionItemService,
  InspectionItemUpdate,
} from './inspection-item.service';

/** 설비 점검항목 마스터. 화면은 `W-05-12` §4-C-1 이다. */
@Controller('mdm/equipment-inspection-items')
export class InspectionItemController {
  constructor(
    private readonly items: InspectionItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/equipment-inspection-items')
  list(@Query() query: InspectionItemQuery): Promise<PagedResponse<unknown>> {
    return this.items.list(query);
  }

  @Get(':equipmentInspectionItemId')
  @Contract('GET /mdm/equipment-inspection-items/{equipmentInspectionItemId}')
  async get(
    @Param('equipmentInspectionItemId', ParseIntPipe) equipmentInspectionItemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { equipmentInspectionItem, editability, assignmentCount, versionNo } =
      await this.items.get(equipmentInspectionItemId);
    setEtag(response, versionNo);
    return { equipmentInspectionItem, editability, assignmentCount };
  }

  @Post()
  @Contract('POST /mdm/equipment-inspection-items')
  create(@Req() request: Request, @Body() body: InspectionItemCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.items.create(body),
    );
  }

  @Put(':equipmentInspectionItemId')
  @Contract('PUT /mdm/equipment-inspection-items/{equipmentInspectionItemId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('equipmentInspectionItemId', ParseIntPipe) equipmentInspectionItemId: number,
    @Body() body: InspectionItemUpdate,
  ): Promise<unknown> {
    return runVersioned(
      this.idempotency,
      request,
      response,
      'equipmentInspectionItem',
      (version) => this.items.update(equipmentInspectionItemId, version, body),
    );
  }
}
