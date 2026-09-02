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
import { runIdempotent, runVersioned } from '../../common/master-write';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { WarehouseQuery, WarehouseService } from './warehouse.service';

/** 창고 마스터. 화면은 `W-06-07`(물류 마스터)가 소유한다. */
@Controller('mdm/warehouses')
export class WarehouseController {
  constructor(
    private readonly warehouses: WarehouseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/warehouses')
  list(@Query() query: WarehouseQuery): Promise<PagedResponse<unknown>> {
    return this.warehouses.list(query);
  }

  @Get(':warehouseId')
  @Contract('GET /mdm/warehouses/{warehouseId}')
  async get(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { warehouse, editability, versionNo } = await this.warehouses.get(warehouseId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    // ⛔ 상세만 래퍼다(`WarehouseDetailResponse`). 수정·전이는 본체를 낸다.
    return { warehouse, editability };
  }

  @Post()
  @Contract('POST /mdm/warehouses')
  create(@Req() request: Request, @Body() body: WarehouseCreateBody): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.warehouses.create(body),
    );
  }

  @Put(':warehouseId')
  @Contract('PUT /mdm/warehouses/{warehouseId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Body() body: WarehouseUpdateBody,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'warehouse', (version) =>
      this.warehouses.update(warehouseId, version, body),
    );
  }

  @Post(':warehouseId\\:activate')
  @Contract('POST /mdm/warehouses/{warehouseId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'warehouse', (version) =>
      this.warehouses.setActive(warehouseId, version, true),
    );
  }

  @Post(':warehouseId\\:deactivate')
  @Contract('POST /mdm/warehouses/{warehouseId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'warehouse', (version) =>
      this.warehouses.setActive(warehouseId, version, false),
    );
  }
}

interface WarehouseCreateBody {
  plantId: number;
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  managementLevelCode: string;
  isExternal?: boolean;
  isDefect?: boolean;
  partnerId?: number | null;
}

interface WarehouseUpdateBody {
  businessUnitId: number;
  warehouseCode: string;
  warehouseName: string;
  warehouseTypeCode: string;
  managementLevelCode: string;
  isExternal: boolean;
  isDefect: boolean;
  partnerId?: number | null;
}
