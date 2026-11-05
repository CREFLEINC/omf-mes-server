import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import {
  ReplenishmentItemCreate,
  ReplenishmentItemQuery,
  ReplenishmentItemService,
  ReplenishmentItemUpdate,
  ReplenishmentItemView,
} from './replenishment-item.service';

/** 생산 창고 보충 — 관리 품목(W-02-12 · 피처 004). */
@Controller('logistics/replenishment-items')
export class ReplenishmentItemController {
  constructor(
    private readonly items: ReplenishmentItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/replenishment-items')
  list(@Query() query: ReplenishmentItemQuery): Promise<PagedResponse<ReplenishmentItemView>> {
    return this.items.list(query);
  }

  @Post()
  @Contract('POST /logistics/replenishment-items')
  create(@Req() request: Request, @Body() body: ReplenishmentItemCreate): Promise<ReplenishmentItemView> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, (tx) => this.items.create(tx, body, appUserId));
  }

  @Put(':replenishmentItemId')
  @Contract('PUT /logistics/replenishment-items/{replenishmentItemId}')
  update(
    @Req() request: Request,
    @Param('replenishmentItemId', ParseIntPipe) id: number,
    @Body() body: ReplenishmentItemUpdate,
  ): Promise<ReplenishmentItemView> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.items.update(tx, id, body, appUserId));
  }

  @Delete(':replenishmentItemId')
  @Contract('DELETE /logistics/replenishment-items/{replenishmentItemId}')
  @HttpCode(HttpStatus.OK)
  remove(@Req() request: Request, @Param('replenishmentItemId', ParseIntPipe) id: number): Promise<{ inProgressRequestCount: number }> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) => this.items.remove(tx, id, appUserId));
  }
}

export function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
