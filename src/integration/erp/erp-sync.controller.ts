import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { assertOperationPermission } from '../../common/permissions';
import { CustomsClearanceService, CustomsFetchResult } from './customs-clearance.service';
import { ErpSyncStatus, ErpSyncStatusService } from './erp-sync-status.service';
import { ErpWarehouseQuery, ErpWarehouseRow, ErpWarehouseService } from './erp-warehouse.service';

/** 상태는 연계 메시지 목록을 보는 화면이 함께 본다(W-02-06·W-06-06·W-06-09·W-06-10). */
const STATUS_OPERATION = 'GET /integration/messages';
/** 「지금 읽기」는 실패 재처리와 같은 화면의 일이다(W-06-10). */
const RUN_OPERATION = 'POST /integration/messages:retry-batch';

/**
 * ERP 받기 표별 상태와 「지금 읽기」(장부 P-81) · ERP 창고(P-147) · 외자 발주 통관번호 받아오기(P-143). 화면은 관리웹 「ERP 연동 현황·이력」 탭(W-06-10).
 * ⛔ 통관번호 받아오기를 뺀 세 경로는 계약에 없어 `@Contract` 를 달 수 없고, 그래서 인증·권한 가드가 그 핸들러를 보지 않는다.
 * 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401 · 오퍼레이션 권한 403)를 여기서 부른다(P-58 과 같은 길).
 * 계약에 경로를 적으면 `@Contract` 를 달고 이 수동 인증을 지운다.
 */
@Controller('integration/erp-sync')
export class ErpSyncController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly status: ErpSyncStatusService,
    private readonly customs: CustomsClearanceService,
    private readonly erpWarehouses: ErpWarehouseService,
  ) {}

  @Get('tables')
  async list(@Req() request: Request): Promise<ErpSyncStatus> {
    await this.authorize(request, STATUS_OPERATION);
    return this.status.list();
  }

  /** 202 — 적어 두기만 한다. 돌았는지는 목록의 `requestedAt`·`running`·`lastFinishedAt` 으로 본다. */
  @Post('tables/:interfaceCode\\:run')
  @HttpCode(HttpStatus.ACCEPTED)
  async run(
    @Req() request: Request,
    @Param('interfaceCode') interfaceCode: string,
  ): Promise<{ interfaceCode: string; requestedAt: string }> {
    const session = await this.authorize(request, RUN_OPERATION);
    return this.status.request(interfaceCode, session.userId);
  }

  /** ERP 창고(공통코드 SL_TYPE)와 같은 코드의 MES 창고(장부 P-147) — 화면은 「ERP 연동 현황·이력 > 창고」. */
  @Get('warehouses')
  async warehouses(@Req() request: Request, @Query() query: ErpWarehouseQuery): Promise<PagedResponse<ErpWarehouseRow>> {
    await this.authorize(request, STATUS_OPERATION);
    return this.erpWarehouses.list(query);
  }

  /**
   * 외자 발주의 통관번호 받아오기(장부 P-143) — 화면은 「ERP 연동 현황·이력 > 구매 발주」. 구매입고를 보낼 때도 없으면 받는다 —
   * 이 버튼은 미리 받아 확인하는 자리다. 「지금 읽기」와 같은 화면의 일이다(W-06-10).
   */
  @Post('purchase-orders/:purchaseOrderId/customs-clearances\\:fetch')
  @HttpCode(HttpStatus.OK)
  @Contract('POST /integration/erp-sync/purchase-orders/{purchaseOrderId}/customs-clearances:fetch')
  fetchCustoms(@Param('purchaseOrderId', ParseIntPipe) purchaseOrderId: number): Promise<CustomsFetchResult> {
    return this.customs.fetchOrder(purchaseOrderId);
  }

  private async authorize(request: Request, operation: string): Promise<Session> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    assertOperationPermission(session, operation);
    return session;
  }
}
