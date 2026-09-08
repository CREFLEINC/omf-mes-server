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
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
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
import { InventoryAdjustmentCreate } from './inventory-adjustment-rules';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

/**
 * 재고 조정 7건 중 조회 3 + 등록. 화면은 `W-01-12` 가 소유한다. 치환·상신·전기는 뒤 PR.
 * 계약이 조회 3건에 403 을 선언하지 않아 `manual-permissions.ts` 에 없다(I-14.md §7).
 */
@Controller('inventory/adjustments')
export class InventoryAdjustmentController {
  constructor(
    private readonly queries: InventoryAdjustmentQueryService,
    private readonly adjustments: InventoryAdjustmentService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  /**
   * 등록. 언제나 `REGISTERED` 로 끝난다 — 계약 본문에 `postImmediately` 가 없다.
   * ⭐ 201 에 ETag 를 «내린다» — 계약이 이 자리에 헤더를 선언했다(입고 201 과 갈린다).
   * ⛔ If-Match 는 안 받는다 — 새 자원이라 대조할 버전이 없다(C-9).
   */
  @Post()
  @Contract('POST /inventory/adjustments')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: InventoryAdjustmentCreate,
  ): Promise<InventoryAdjustmentDetail> {
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.adjustments.create(body, userOf(request)),
    );
    setEtag(response, result.versionNo);
    return result.detail;
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

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
