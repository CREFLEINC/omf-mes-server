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

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  ApprovalRouteCreateInput,
  ApprovalRouteQuery,
  ApprovalRouteService,
  ApprovalRouteStepInput,
  ApprovalRouteUpdateInput,
} from './approval-route.service';
import { ApprovalRouteStepView, ApprovalRouteView } from './approval.mapper';

/** 결재선 정의(마스터) + 결재 단계 치환 + 활성 전이. 화면은 `W-06-15`(결재선 정의)가 소유한다. */
@Controller('app/approval-routes')
export class ApprovalRouteController {
  constructor(
    private readonly routes: ApprovalRouteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/approval-routes')
  list(@Query() query: ApprovalRouteQuery): Promise<PagedResponse<ApprovalRouteView>> {
    return this.routes.list(query);
  }

  @Post()
  @Contract('POST /app/approval-routes')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: ApprovalRouteCreateInput,
  ): Promise<ApprovalRouteView> {
    // 이 저장소 최초 「201 + ETag」 — `runVersioned` 는 200 전용이라 못 쓴다(I-1.md R-6).
    // 헬퍼로 빼지 않는다 — 사용처가 여기 하나다.
    const result = await runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.routes.create(body),
    );
    setEtag(response, result.versionNo);
    return result.route;
  }

  @Get(':approvalRouteId')
  @Contract('GET /app/approval-routes/{approvalRouteId}')
  async get(
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApprovalRouteView> {
    const result = await this.routes.get(approvalRouteId);
    setEtag(response, result.versionNo);
    return result.route;
  }

  @Put(':approvalRouteId')
  @Contract('PUT /app/approval-routes/{approvalRouteId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
    @Body() body: ApprovalRouteUpdateInput,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'route', (version) =>
      this.routes.update(approvalRouteId, version, body),
    );
  }

  @Post(':approvalRouteId\\:activate')
  @Contract('POST /app/approval-routes/{approvalRouteId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'route', (version) =>
      this.routes.activate(approvalRouteId, version),
    );
  }

  @Post(':approvalRouteId\\:deactivate')
  @Contract('POST /app/approval-routes/{approvalRouteId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'route', (version) =>
      this.routes.deactivate(approvalRouteId, version),
    );
  }

  @Get(':approvalRouteId/steps')
  @Contract('GET /app/approval-routes/{approvalRouteId}/steps')
  async listSteps(
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
  ): Promise<{ items: ApprovalRouteStepView[] }> {
    return { items: await this.routes.listSteps(approvalRouteId) };
  }

  @Put(':approvalRouteId/steps')
  @Contract('PUT /app/approval-routes/{approvalRouteId}/steps')
  async replaceSteps(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('approvalRouteId', ParseIntPipe) approvalRouteId: number,
    @Body() body: { steps: ApprovalRouteStepInput[] },
  ): Promise<unknown> {
    // 토큰은 부모 approval_route.version_no 다(approval_route_step 에는 version_no 가
    // 없다) — 선례 item-detail.service.ts withBumpedItem. 계약은 이 응답의 ETag 를
    // 선언하지 않지만 선례를 따라 그대로 낸다(알려둘 것 ⓐ, I-1.md R-4).
    const items = await runVersioned<ApprovalRouteStepView[], 'items'>(
      this.idempotency,
      request,
      response,
      'items',
      (version) => this.routes.replaceSteps(approvalRouteId, version, body.steps),
    );
    return { items };
  }
}
