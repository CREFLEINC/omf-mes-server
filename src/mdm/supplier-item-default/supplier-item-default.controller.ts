import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  SupplierItemDefaultCreate,
  SupplierItemDefaultQuery,
  SupplierItemDefaultService,
  SupplierItemDefaultUpdate,
  SupplierItemDefaultView,
} from './supplier-item-default.service';

/** 공급사·품목 기본 정보(W-06-25 · 피처 005). 발행 화면(P-01-01·W-01-14)이 기본값으로 읽는다. */
@Controller('mdm/supplier-item-defaults')
export class SupplierItemDefaultController {
  constructor(
    private readonly defaults: SupplierItemDefaultService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/supplier-item-defaults')
  list(@Query() query: SupplierItemDefaultQuery): Promise<PagedResponse<SupplierItemDefaultView>> {
    return this.defaults.list(query);
  }

  @Post()
  @Contract('POST /mdm/supplier-item-defaults')
  create(@Req() request: Request, @Body() body: SupplierItemDefaultCreate): Promise<SupplierItemDefaultView> {
    const appUserId = currentSession(request)?.userId;
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, (tx) => this.defaults.create(tx, body, appUserId));
  }

  @Put(':supplierItemDefaultId')
  @Contract('PUT /mdm/supplier-item-defaults/{supplierItemDefaultId}')
  update(
    @Req() request: Request,
    @Param('supplierItemDefaultId', ParseIntPipe) id: number,
    @Body() body: SupplierItemDefaultUpdate,
  ): Promise<SupplierItemDefaultView> {
    const appUserId = currentSession(request)?.userId;
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.defaults.update(tx, id, body, appUserId));
  }

  @Delete(':supplierItemDefaultId')
  @Contract('DELETE /mdm/supplier-item-defaults/{supplierItemDefaultId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() request: Request, @Param('supplierItemDefaultId', ParseIntPipe) id: number): Promise<void> {
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async (tx) => {
      await this.defaults.remove(tx, id);
      return undefined;
    });
  }
}
