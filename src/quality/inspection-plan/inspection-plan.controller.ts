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
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { InspectionPlanCopy, InspectionPlanCopyService } from './inspection-plan-copy.service';
import {
  InspectionPlanQuery,
  InspectionPlanService,
  InspectionPlanCreate,
  InspectionPlanWrite,
} from './inspection-plan.service';

/** 검사기준 헤더. 화면은 `W-06-02`(검사기준 등록 — IQC/PQC/OQC)가 소유한다. */
@Controller('quality/inspection-plans')
export class InspectionPlanController {
  constructor(
    private readonly plans: InspectionPlanService,
    private readonly copies: InspectionPlanCopyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-plans')
  list(@Query() query: InspectionPlanQuery): Promise<PagedResponse<unknown>> {
    return this.plans.list(query);
  }

  @Get(':inspectionPlanId')
  @Contract('GET /quality/inspection-plans/{inspectionPlanId}')
  async get(
    @Req() request: Request,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { inspectionPlan, editability, versionNo } = await this.plans.get(inspectionPlanId, currentTerminalQualityReadScope(request));
    setEtag(response, versionNo);
    return { inspectionPlan, editability };
  }

  @Post()
  @Contract('POST /quality/inspection-plans')
  create(@Req() request: Request, @Body() body: InspectionPlanCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.plans.create(body),
    );
  }

  @Put(':inspectionPlanId')
  @Contract('PUT /quality/inspection-plans/{inspectionPlanId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
    @Body() body: InspectionPlanWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'inspectionPlan', (version) =>
      this.plans.update(inspectionPlanId, version, body),
    );
  }

  @Post(':inspectionPlanId\\:approve')
  @Contract('POST /quality/inspection-plans/{inspectionPlanId}:approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Req() request: Request,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
  ): Promise<unknown> {
    // ⛔ 승인자는 «현재 사용자»다 — 본문으로 받지 않는다(계약). 세션이 없으면 인증 가드가
    // 이미 막았으므로 여기 오면 값이 있다.
    const actorId = currentSession(request)?.userId;
    if (actorId === undefined) throw new Error('세션 없이 승인이 도달했다 — 인증 가드와 어긋났다');

    const { inspectionPlan } = await runIdempotent(
      this.idempotency,
      request,
      HttpStatus.OK,
      () => this.plans.approve(inspectionPlanId, actorId),
    );
    return inspectionPlan;
  }

  /** 복사(omf-all-around#255) — 원본 버전의 설정 · 검사 항목을 담은 새 기준(버전 1 작성중)을 만든다. */
  @Post(':inspectionPlanId\\:copy')
  @Contract('POST /quality/inspection-plans/{inspectionPlanId}:copy')
  copy(
    @Req() request: Request,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
    @Body() body: InspectionPlanCopy,
  ): Promise<unknown> {
    const actorId = currentSession(request)?.userId;
    if (actorId === undefined) throw new Error('세션 없이 복사가 도달했다 — 인증 가드와 어긋났다');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.copies.copy(inspectionPlanId, body, actorId),
    );
  }

  @Post(':inspectionPlanId\\:activate')
  @Contract('POST /quality/inspection-plans/{inspectionPlanId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'inspectionPlan', (version) =>
      this.plans.setActive(inspectionPlanId, version, true),
    );
  }

  @Post(':inspectionPlanId\\:deactivate')
  @Contract('POST /quality/inspection-plans/{inspectionPlanId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionPlanId', ParseIntPipe) inspectionPlanId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'inspectionPlan', (version) =>
      this.plans.setActive(inspectionPlanId, version, false),
    );
  }
}
