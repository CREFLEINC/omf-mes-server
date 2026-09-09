import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { HandlingUnitQuery, HandlingUnitQueryService } from './handling-unit-query.service';
import { HandlingUnitContentView, HandlingUnitDetailView, HandlingUnitView } from './handling-unit-view';

/**
 * 취급 단위 7 오퍼레이션 중 조회 3건(PR ①) — 골격만. 등록·구성 치환·포장 확정·재구성
 * 이력 조회는 뒤 PR 이 이 컨트롤러에 얹는다(계획 `docs/coverage-100/slices/I-16-a2.md`
 * §11-3 — 스택 ①→②→③→④→⑤).
 */
@Controller('inventory/handling-units')
export class HandlingUnitController {
  constructor(private readonly queries: HandlingUnitQueryService) {}

  @Get()
  @Contract('GET /inventory/handling-units')
  list(@Query() query: HandlingUnitQuery): Promise<PagedResponse<HandlingUnitView>> {
    return this.queries.list(query);
  }

  @Get(':handlingUnitId')
  @Contract('GET /inventory/handling-units/{handlingUnitId}')
  async get(
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HandlingUnitDetailView> {
    const { handlingUnit, contents, versionNo } = await this.queries.get(handlingUnitId);
    setEtag(response, versionNo);
    return { handlingUnit, contents };
  }

  /** ⛔ 자식 컬렉션 GET 이라 ETag 를 안 붙인다(계약 원문 — 잠그는 단위는 부모다). */
  @Get(':handlingUnitId/contents')
  @Contract('GET /inventory/handling-units/{handlingUnitId}/contents')
  async contents(
    @Param('handlingUnitId', ParseIntPipe) handlingUnitId: number,
  ): Promise<{ items: HandlingUnitContentView[] }> {
    return { items: await this.queries.contents(handlingUnitId) };
  }
}
