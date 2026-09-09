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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { requestFingerprint } from '../../common/idempotency';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  InventoryCountLineQuery,
  InventoryCountQuery,
  InventoryCountQueryService,
} from './inventory-count-query.service';
import {
  InventoryCountDetail,
  InventoryCountLineView,
  InventoryCountView,
} from './inventory-count-view';
import {
  InventoryCountCreate,
  InventoryCountCreateService,
} from './inventory-count-create.service';

@Controller('inventory/counts')
export class InventoryCountController {
  constructor(
    private readonly counts: InventoryCountQueryService,
    private readonly creates: InventoryCountCreateService,
  ) {}

  @Get()
  @Contract('GET /inventory/counts')
  list(@Query() query: InventoryCountQuery): Promise<PagedResponse<InventoryCountView>> {
    return this.counts.list(query);
  }

  @Post()
  @Contract('POST /inventory/counts')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: InventoryCountCreate,
  ): Promise<InventoryCountDetail> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    const result = await this.creates.create(body, {
      key: String(request.headers['idempotency-key']),
      fingerprint: requestFingerprint(`${request.method} ${request.path}`, request.body),
      appUserId: session.userId,
      successStatus: HttpStatus.CREATED,
    });
    setEtag(response, result.versionNo);
    return result.detail;
  }

  @Get(':inventoryCountId')
  @Contract('GET /inventory/counts/{inventoryCountId}')
  async get(
    @Param('inventoryCountId', ParseIntPipe) inventoryCountId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryCountDetail> {
    const { detail, versionNo } = await this.counts.get(inventoryCountId);
    setEtag(response, versionNo);
    return detail;
  }

  @Get(':inventoryCountId/lines')
  @Contract('GET /inventory/counts/{inventoryCountId}/lines')
  lines(
    @Param('inventoryCountId', ParseIntPipe) inventoryCountId: number,
    @Query() query: InventoryCountLineQuery,
  ): Promise<PagedResponse<InventoryCountLineView>> {
    return this.counts.lines(inventoryCountId, query);
  }
}
