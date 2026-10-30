import { Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { CustomsClearanceService, CustomsFetchResult } from './customs-clearance.service';
import { ErpSyncStatus, ErpSyncStatusService } from './erp-sync-status.service';
import { ErpWarehouseQuery, ErpWarehouseRow, ErpWarehouseService } from './erp-warehouse.service';

/**
 * ERP 받기 표별 상태와 「지금 읽기」(장부 P-81) · ERP 창고(P-147) · 외자 발주 통관번호 받아오기(P-143). 화면은 관리웹 「ERP 연동 현황·이력」 탭(W-06-10).
 */
@Controller('integration/erp-sync')
export class ErpSyncController {
  constructor(
    private readonly status: ErpSyncStatusService,
    private readonly customs: CustomsClearanceService,
    private readonly erpWarehouses: ErpWarehouseService,
  ) {}

  @Get('tables')
  @Contract('GET /integration/erp-sync/tables')
  list(): Promise<ErpSyncStatus> {
    return this.status.list();
  }

  /** 202 — 적어 두기만 한다. 돌았는지는 목록의 `requestedAt`·`running`·`lastFinishedAt` 으로 본다. */
  @Post('tables/:interfaceCode\\:run')
  @HttpCode(HttpStatus.ACCEPTED)
  @Contract('POST /integration/erp-sync/tables/{interfaceCode}:run')
  run(
    @Req() request: Request,
    @Param('interfaceCode') interfaceCode: string,
  ): Promise<{ interfaceCode: string; requestedAt: string }> {
    return this.status.request(interfaceCode, currentSession(request)?.userId);
  }

  /** ERP 창고(공통코드 SL_TYPE)와 같은 코드의 MES 창고(장부 P-147) — 화면은 「ERP 연동 현황·이력 > 창고」. */
  @Get('warehouses')
  @Contract('GET /integration/erp-sync/warehouses')
  warehouses(@Query() query: ErpWarehouseQuery): Promise<PagedResponse<ErpWarehouseRow>> {
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
}
