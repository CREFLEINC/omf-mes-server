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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
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
import {
  InventoryAdjustmentCreate,
  InventoryAdjustmentLineCreate,
} from './inventory-adjustment-rules';
import { InventoryAdjustmentUpdateService } from './inventory-adjustment-update.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';

/**
 * 재고 조정 7건 중 조회 3 + 등록 + 치환 + 상신. 화면은 `W-01-12` 가 소유한다. `:post` 는 뒤 PR.
 * 계약이 조회 3건에 403 을 선언하지 않아 `manual-permissions.ts` 에 없다(I-14.md §7).
 */
@Controller('inventory/adjustments')
export class InventoryAdjustmentController {
  constructor(
    private readonly queries: InventoryAdjustmentQueryService,
    private readonly adjustments: InventoryAdjustmentService,
    private readonly updates: InventoryAdjustmentUpdateService,
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

  /**
   * 라인 전량 치환. If-Match 는 «부모» `inventory_adjustment.version_no` 다(계약 · B-1-1).
   * ⭐ 200 에 ETag 를 «내린다» — 계약이 「라인을 고치면 이 헤더의 값이 오르므로 다음 상태
   * 전이(`:request-approval`·`:post`)는 이 값을 쓴다」고 적었다. 출고는 이 자리에 헤더가
   * 미선언이라 안 내렸다 — 베끼면 빠뜨린다.
   */
  @Put(':inventoryAdjustmentId/lines')
  @Contract('PUT /inventory/adjustments/{inventoryAdjustmentId}/lines')
  async replaceLines(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inventoryAdjustmentId', ParseIntPipe) inventoryAdjustmentId: number,
    @Body() body: { items: InventoryAdjustmentLineCreate[] },
  ): Promise<{ items: InventoryAdjustmentLineView[] }> {
    const appUserId = userOf(request);
    const items = await runVersioned<InventoryAdjustmentLineView[], 'items'>(
      this.idempotency,
      request,
      response,
      'items',
      (version) => this.updates.replaceLines(inventoryAdjustmentId, version, body.items, appUserId),
    );
    return { items };
  }

  /** ⭐ 202 다 — 요청을 «접수»할 뿐 결재는 결재함이 한다. 승인 유형은 서버가 낸다(본문 미수신). */
  @Post(':inventoryAdjustmentId\\:request-approval')
  @Contract('POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval')
  @HttpCode(HttpStatus.ACCEPTED)
  requestApproval(
    @Req() request: Request,
    @Param('inventoryAdjustmentId', ParseIntPipe) inventoryAdjustmentId: number,
    @Body() body: { reason: string },
  ): Promise<{ approvalRequestId: number }> {
    const version = versionOf(request);
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, () =>
      this.updates.requestApproval(inventoryAdjustmentId, version, body.reason, appUserId),
    );
  }
}

/** ⛔ 상신은 `runVersioned` 를 못 쓴다 — 202 에 ETag 가 없어 새 토큰을 내릴 자리가 없다.
 *  대신 가드가 파싱해 둔 If-Match 값을 꺼내 서비스가 «비교만» 한다(출고 선례). */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
