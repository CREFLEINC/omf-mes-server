import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { DepartmentProductionWarehouseService } from './department-production-warehouse.service';

/** 부서 생산 창고(피처 003). 화면은 `W-06-06` 부서 폼의 「생산 창고」 구획이다. */
@Controller('mdm/departments')
export class DepartmentProductionWarehouseController {
  constructor(
    private readonly warehouses: DepartmentProductionWarehouseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':departmentId/production-warehouses')
  @Contract('GET /mdm/departments/{departmentId}/production-warehouses')
  list(@Param('departmentId', ParseIntPipe) departmentId: number): Promise<unknown> {
    return this.warehouses.list(departmentId);
  }

  /** `dryRun=true` 는 저장하지 않고 같은 응답을 낸다 — 화면이 연결 해제 확인 창을 띄울지 묻는다. */
  @Put(':departmentId/production-warehouses')
  @Contract('PUT /mdm/departments/{departmentId}/production-warehouses')
  replace(
    @Req() request: Request,
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Query('dryRun') dryRun: string | boolean | undefined,
    @Body() body: { warehouseIds: number[] },
  ): Promise<unknown> {
    const preview = dryRun === true || dryRun === 'true';
    const run = () =>
      this.warehouses.replace(departmentId, body.warehouseIds, preview, currentSession(request)?.userId);
    // 미리보기는 아무것도 바꾸지 않으므로 멱등 기록을 남기지 않는다 — 같은 키로 저장할 수 있어야 한다.
    return preview ? run() : runIdempotent(this.idempotency, request, HttpStatus.OK, run);
  }
}
