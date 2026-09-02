import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ItemQuery, ItemService, ItemUpdate } from './item.service';

/**
 * 품목 마스터. 두 화면이 같은 목록을 쓴다 — `W-06-05`(확장 속성 편집)와
 * `W-06-01`(Routing 을 붙일 대상 고르기).
 *
 * ERP 수신본이라 등록·삭제가 없다. `:deactivate` 도 없다 — `isActive` 를 `PUT` 본문으로
 * 바꾼다(계약이 「사용 중지 액션이 화면에 없다」로 적었다).
 */
@Controller('mdm/items')
export class ItemController {
  constructor(
    private readonly items: ItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/items')
  list(@Query() query: ItemQuery): Promise<PagedResponse<unknown>> {
    return this.items.list(query);
  }

  @Get(':itemId')
  @Contract('GET /mdm/items/{itemId}')
  async get(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { item, editability, versionNo } = await this.items.get(itemId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    // ⛔ 상세만 래퍼다(`ItemDetailResponse`). 수정은 본체를 낸다.
    return { item, editability };
  }

  @Put(':itemId')
  @Contract('PUT /mdm/items/{itemId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: ItemUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'item', (version) =>
      this.items.update(itemId, version, body),
    );
  }
}
