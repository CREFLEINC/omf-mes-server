import {
  Body,
  Controller,
  Delete,
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
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import {
  ProductionPlanCreate,
  ProductionPlanListQuery,
  ProductionPlanService,
  ProductionPlanUpdate,
} from './production-plan.service';
import { ProductionPlanView } from './production-plan-view';

/** 생산계획 조회 2 + CRUD 3(PR ①a·②) — `:confirm` 은 PR ③ 몫. */
@Controller('planning/production-plans')
export class ProductionPlanController {
  constructor(
    private readonly queries: ProductionPlanService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /planning/production-plans')
  list(@Query() query: ProductionPlanListQuery): Promise<PagedResponse<ProductionPlanView>> {
    return this.queries.list(query);
  }

  @Get(':productionPlanId')
  @Contract('GET /planning/production-plans/{productionPlanId}')
  async detail(
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductionPlanView> {
    const { view, versionNo } = await this.queries.detail(productionPlanId);
    setEtag(response, versionNo);
    return view;
  }

  @Post()
  @Contract('POST /planning/production-plans')
  @HttpCode(HttpStatus.CREATED)
  create(@Req() request: Request, @Body() body: ProductionPlanCreate): Promise<ProductionPlanView> {
    // ⛔ `setEtag` 를 안 부른다 — 계약이 201 에 ETag 를 선언하지 않았다(I-24 §4-1).
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.queries.create(body, currentSession(request)?.userId),
    );
  }

  @Put(':productionPlanId')
  @Contract('PUT /planning/production-plans/{productionPlanId}')
  update(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
    @Body() body: ProductionPlanUpdate,
  ): Promise<ProductionPlanView> {
    // ⛔ `runVersioned` 를 못 쓴다 — 계약이 200 에 ETag 를 선언하지 않는다(work-order 선례).
    const version = versionOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.queries.update(productionPlanId, version, body, currentSession(request)?.userId),
    );
  }

  @Delete(':productionPlanId')
  @Contract('DELETE /planning/production-plans/{productionPlanId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
  ): Promise<void> {
    const version = versionOf(request);
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.queries.remove(productionPlanId, version);
      return undefined;
    });
  }
}

function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}
