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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { scopedPlantIds } from '../production-order/production-order-scope';
import { PlanConfirmService } from './plan-confirm.service';
import {
  ProductionPlanCreate,
  ProductionPlanListQuery,
  ProductionPlanService,
  ProductionPlanUpdate,
} from './production-plan.service';
import { ProductionPlanView } from './production-plan-view';

/**
 * 생산계획 조회 2 + CRUD 3 + 확정 전개. 사용자 데이터 범위(ERP W/O 목록과 같은 규칙)는 계획의 ERP W/O 공장으로 본다 —
 * 범위 밖 계획은 없는 것과 같다(404, 목록은 범위 안만). 쓰기는 멱등 처리보다 먼저 막는다.
 */
@Controller('planning/production-plans')
export class ProductionPlanController {
  constructor(
    private readonly queries: ProductionPlanService,
    private readonly confirms: PlanConfirmService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /planning/production-plans')
  async list(@Req() request: Request, @Query() query: ProductionPlanListQuery): Promise<PagedResponse<ProductionPlanView>> {
    return this.queries.list(query, await this.scopeOf(request));
  }

  @Get(':productionPlanId')
  @Contract('GET /planning/production-plans/{productionPlanId}')
  async detail(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductionPlanView> {
    const { view, versionNo } = await this.queries.detail(productionPlanId, await this.scopeOf(request));
    setEtag(response, versionNo);
    return view;
  }

  @Post()
  @Contract('POST /planning/production-plans')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() request: Request, @Body() body: ProductionPlanCreate): Promise<ProductionPlanView> {
    const scope = await this.scopeOf(request);
    // ⛔ `setEtag` 를 안 부른다 — 계약이 201 에 ETag 를 선언하지 않았다(I-24 §4-1).
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.queries.create(body, currentSession(request)?.userId, scope), FAMILY_CONFLICT_CODE);
  }

  @Put(':productionPlanId')
  @Contract('PUT /planning/production-plans/{productionPlanId}')
  async update(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
    @Body() body: ProductionPlanUpdate,
  ): Promise<ProductionPlanView> {
    // ⛔ `runVersioned` 를 못 쓴다 — 계약이 200 에 ETag 를 선언하지 않는다(work-order 선례).
    const version = versionOf(request);
    await this.queries.assertInScope(productionPlanId, await this.scopeOf(request));
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.queries.update(productionPlanId, version, body, currentSession(request)?.userId), FAMILY_CONFLICT_CODE);
  }

  /** 확정 + W/O 전개. ⛔ `setEtag` 를 안 부른다 — 계약이 200 에 ETag 를 선언하지 않았다. */
  @Post(':productionPlanId\\:confirm')
  @Contract('POST /planning/production-plans/{productionPlanId}:confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
  ): Promise<ProductionPlanView> {
    const version = versionOf(request);
    await this.queries.assertInScope(productionPlanId, await this.scopeOf(request));
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.confirms.confirm(productionPlanId, version, currentSession(request)?.userId), FAMILY_CONFLICT_CODE);
  }

  @Delete(':productionPlanId')
  @Contract('DELETE /planning/production-plans/{productionPlanId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() request: Request,
    @Param('productionPlanId', ParseIntPipe) productionPlanId: number,
  ): Promise<void> {
    const version = versionOf(request);
    await this.queries.assertInScope(productionPlanId, await this.scopeOf(request));
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.queries.remove(productionPlanId, version);
      return undefined;
    }, FAMILY_CONFLICT_CODE);
  }

  private async scopeOf(request: Request): Promise<bigint[] | null> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return scopedPlantIds(this.prisma, session.userId);
  }
}

function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}
