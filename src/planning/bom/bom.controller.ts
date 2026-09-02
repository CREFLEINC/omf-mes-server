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
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { BomComponentUpdate, BomQuery, BomService } from './bom.service';

/**
 * BOM. ⛔ **ERP 정본**이라 이 시스템이 만들거나 지우지 않는다 — 고치는 것은 구성품의
 * MES 확장 네 칸뿐이다. 화면은 `W-06-05`(수신본 확장속성 편집)가 소유한다.
 */
@Controller('planning/boms')
export class BomController {
  constructor(
    private readonly boms: BomService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /planning/boms')
  async list(@Query() query: BomQuery): Promise<unknown> {
    return { items: await this.boms.list(query) };
  }

  @Get(':bomId')
  @Contract('GET /planning/boms/{bomId}')
  get(@Param('bomId', ParseIntPipe) bomId: number): Promise<unknown> {
    // ⚠ 계약이 이 자리에 ETag 를 선언하지 않았다 — 헤더는 편집 경로가 없어 If-Match 를
    // 실을 쓰기가 없다. 구성품 상세 쪽에만 있다.
    return this.boms.get(bomId);
  }

  @Get(':bomId/components')
  @Contract('GET /planning/boms/{bomId}/components')
  async listComponents(@Param('bomId', ParseIntPipe) bomId: number): Promise<unknown> {
    return { items: await this.boms.listComponents(bomId) };
  }

  @Get(':bomId/components/:bomComponentId')
  @Contract('GET /planning/boms/{bomId}/components/{bomComponentId}')
  async getComponent(
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('bomComponentId', ParseIntPipe) bomComponentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { bomComponent, editability, versionNo } = await this.boms.getComponent(
      bomId,
      bomComponentId,
    );
    // 「행 단위 GET 신설로 PUT 의 If-Match 가 실을 ETag 자리가 비로소 생겼다」(계약).
    setEtag(response, versionNo);
    return { bomComponent, editability };
  }

  @Put(':bomId/components/:bomComponentId')
  @Contract('PUT /planning/boms/{bomId}/components/{bomComponentId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('bomId', ParseIntPipe) bomId: number,
    @Param('bomComponentId', ParseIntPipe) bomComponentId: number,
    @Body() body: BomComponentUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'bomComponent', (version) =>
      this.boms.updateComponent(
        bomId,
        bomComponentId,
        version,
        body,
        currentSession(request)?.userId,
      ),
    );
  }

  @Post(':bomId\\:set-default')
  @Contract('POST /planning/boms/{bomId}:set-default')
  @HttpCode(HttpStatus.OK)
  setDefault(
    @Req() request: Request,
    @Param('bomId', ParseIntPipe) bomId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.boms.setDefault(bomId),
    );
  }
}
