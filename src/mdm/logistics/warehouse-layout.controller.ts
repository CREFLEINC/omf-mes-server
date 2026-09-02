import { Body, Controller, Get, Param, ParseIntPipe, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { LayoutReplace, WarehouseLayoutService } from './warehouse-layout.service';

/**
 * 창고 배치도. 화면은 `W-CO-08`(창고 배치도)이며 창고 마스터(`W-06-07`)와 다르다 —
 * 컨트롤러를 가른 이유가 그것이다.
 */
@Controller('mdm/warehouses')
export class WarehouseLayoutController {
  constructor(
    private readonly layouts: WarehouseLayoutService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':warehouseId/layout')
  @Contract('GET /mdm/warehouses/{warehouseId}/layout')
  async get(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const layout = await this.layouts.get(warehouseId);
    setEtag(response, layout.versionNo);
    return layout;
  }

  @Put(':warehouseId/layout')
  @Contract('PUT /mdm/warehouses/{warehouseId}/layout')
  replace(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Body() body: LayoutReplace,
  ): Promise<unknown> {
    // `runVersioned` 가 돌려주는 조각 이름이 곧 응답 본문이다. 배치도는 래퍼가 없고
    // `versionNo` 를 본문에도 담으므로, 결과 전체를 그대로 낸다.
    return runVersioned(this.idempotency, request, response, 'layout', async (version) => {
      const layout = await this.layouts.replace(
        warehouseId,
        version,
        body,
        currentSession(request)?.userId,
      );
      return { layout, versionNo: layout.versionNo };
    });
  }
}
