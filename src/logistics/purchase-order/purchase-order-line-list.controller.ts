import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import { PagedResponse } from '../../common/pagination';
import { PurchaseOrderLineListItem, parseLineListQuery } from './purchase-order-line-list';
import { PurchaseOrderLineListService } from './purchase-order-line-list.service';

/**
 * 입하 예정 — 구매발주 라인 목록(장부 P-78 · #741). 화면은 관리웹 W-01-09.
 * ⛔ 이 경로는 계약 사본에 없어 `@Contract` 를 달 수 없고, 그래서 인증·계약 검증 가드가 이 핸들러를 보지 않는다.
 * 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401)를 여기서 부르고, 질의는 `parseLineListQuery` 가 본다.
 * 화면 권한은 보지 않는다 — 같은 화면의 ASN 목록·발주 목록도 계약에 403 이 없어 로그인만 본다.
 * 정본에 경로가 실려 오면 `@Contract` 를 달고 이 수동 인증·검증을 지운다.
 */
@Controller('logistics/purchase-order-lines')
export class PurchaseOrderLineListController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly lines: PurchaseOrderLineListService,
  ) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<PagedResponse<PurchaseOrderLineListItem>> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    return this.lines.list(parseLineListQuery(query));
  }
}
