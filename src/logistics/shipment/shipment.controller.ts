import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ShipmentQueryService } from './shipment-query.service';
import { ShipmentQuery } from './shipment-query.sql';
import { ShipmentDetailView, ShipmentView } from './shipment-view';

/**
 * MES 출하 — 화면 `W-04-04`(처리·확정) · `W-04-12`(취소) · `W-04-02`(목록).
 *
 * ⛔ `OPERATION_PERMISSIONS` 를 **0줄** 건드린다 — 조회는 403 을 «선언하지 않아» 더해도 죽은
 * 행이 되고, 403 을 선언한 다섯은 `DERIVED_PERMISSIONS` 가 **이미 갖고 있다**(§1-1 실측
 * `:68`·`:69`·`:182`~`:185`·`:187`). ⚠ 미등재였다면 가드가 던져 403 이 아니라 **500** 이다.
 * ⛔ `manual-permissions.ts` 에 더하면 `operation-permissions.spec.ts:27-37`(순수 중복 금지)이 빨개진다.
 */
@Controller('logistics/shipments')
export class ShipmentController {
  constructor(private readonly queries: ShipmentQueryService) {}

  @Get()
  @Contract('GET /logistics/shipments')
  list(@Query() query: ShipmentQuery): Promise<PagedResponse<ShipmentView>> {
    return this.queries.list(query);
  }

  @Get(':shipmentId')
  @Contract('GET /logistics/shipments/{shipmentId}')
  async get(
    @Param('shipmentId', ParseIntPipe) shipmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShipmentDetailView> {
    const { view, versionNo } = await this.queries.get(shipmentId);
    // ⛔ 계약이 ETag 를 «상세에만» 선언했다 — :confirm·:cancel 의 If-Match 가 이 값을 담는다.
    // ⚠ Express 가 모든 200 에 약한 content ETag(W/"…")를 스스로 단다 — 목록에도 «헤더는»
    //   있다. 다른 것은 값이다: 여기만 숫자(version_no)라 If-Match 로 쓸 수 있다(e2e D-2).
    setEtag(response, versionNo);
    return view;
  }
}
