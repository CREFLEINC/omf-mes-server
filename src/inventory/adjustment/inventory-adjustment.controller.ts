import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  InventoryAdjustmentQuery,
  InventoryAdjustmentQueryService,
} from './inventory-adjustment-query.service';
import {
  InventoryAdjustmentDetail,
  InventoryAdjustmentLineView,
  InventoryAdjustmentView,
} from './inventory-adjustment-view';

/**
 * 재고 조정 7건 중 조회 3. 화면은 `W-01-12` 가 소유한다. 등록·치환·상신·전기는 뒤 PR.
 * 계약이 조회 3건에 403 을 선언하지 않아 `manual-permissions.ts` 에 없다(I-14.md §7).
 */
@Controller('inventory/adjustments')
export class InventoryAdjustmentController {
  constructor(private readonly queries: InventoryAdjustmentQueryService) {}

  @Get()
  @Contract('GET /inventory/adjustments')
  list(@Query() query: InventoryAdjustmentQuery): Promise<PagedResponse<InventoryAdjustmentView>> {
    return this.queries.list(query);
  }

  @Get(':inventoryAdjustmentId')
  @Contract('GET /inventory/adjustments/{inventoryAdjustmentId}')
  async get(
    @Param('inventoryAdjustmentId', ParseIntPipe) inventoryAdjustmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InventoryAdjustmentDetail> {
    const { detail, versionNo } = await this.queries.get(inventoryAdjustmentId);
    setEtag(response, versionNo);
    return detail;
  }

  /** ⛔ ETag 를 안 붙인다 — 자식 컬렉션이다(계약 미선언 · I-14.md §7). */
  @Get(':inventoryAdjustmentId/lines')
  @Contract('GET /inventory/adjustments/{inventoryAdjustmentId}/lines')
  async lines(
    @Param('inventoryAdjustmentId', ParseIntPipe) inventoryAdjustmentId: number,
  ): Promise<{ items: InventoryAdjustmentLineView[] }> {
    return { items: await this.queries.lines(inventoryAdjustmentId) };
  }
}
