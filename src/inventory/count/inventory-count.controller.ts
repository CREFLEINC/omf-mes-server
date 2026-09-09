import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
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

@Controller('inventory/counts')
export class InventoryCountController {
  constructor(private readonly counts: InventoryCountQueryService) {}

  @Get()
  @Contract('GET /inventory/counts')
  list(@Query() query: InventoryCountQuery): Promise<PagedResponse<InventoryCountView>> {
    return this.counts.list(query);
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
