import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { resolveTerminalId } from '../../auth/terminal-token';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionResultListQuery, InspectionResultQueryService } from './inspection-result-query.service';
import {
  InspectionResultCreate,
  InspectionResultWriteContext,
  InspectionResultWriteService,
} from './inspection-result-write.service';
import { InspectionResultView } from './inspection-result-view';

/**
 * 검사 결과 조회 2건(I-19 PR ②b) + 저장 1건(PR ③b). `PUT`(PR ③c)·`:confirm`(PR ④)이 이어 붙는다.
 * `summary`·`defect-rate-trend`·`measurement-summary`·`/measurements`(PR ⑤)는 **별도
 * 컨트롤러**다(R-18) — 그래도 `quality.module.ts` 의 `controllers` 배열에서 **이 컨트롤러
 * 보다 먼저** 등록해야 한다. `ParseIntPipe` 가 `'summary'` 를 숫자로 못 읽어 400 을 내는
 * 함정은 컨트롤러를 나눠도 라우트 등록 순서에는 그대로 남는다.
 * ⛔ 403 게이트는 `derived-permissions.ts:250-251·280` 에 세 자리가 이미 있다 — `manual-permissions.ts` 0줄.
 */
@Controller('quality/inspection-results')
export class InspectionResultController {
  constructor(
    private readonly results: InspectionResultQueryService,
    private readonly writes: InspectionResultWriteService,
    private readonly idempotency: IdempotencyService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-results')
  list(@Query() query: InspectionResultListQuery): Promise<PagedResponse<InspectionResultView>> {
    return this.results.list(query);
  }

  @Get(':inspectionResultId')
  @Contract('GET /quality/inspection-results/{inspectionResultId}')
  async detail(
    @Param('inspectionResultId', ParseIntPipe) inspectionResultId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InspectionResultView> {
    const { view, versionNo } = await this.results.detail(inspectionResultId);
    setEtag(response, versionNo);
    return view;
  }

  /**
   * 저장. ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**(`IfMatchVersionOptional`)이라 토큰이
   * 없으면 저쪽이 던져 500 이 된다(`master-write.ts:48-51` · I-7 선례). `undefined` 를 그대로
   * 내려보내 서비스가 대조를 건너뛴다. ⛔ ETag 를 안 낸다 — 계약이 201 에 선언하지 않았다.
   */
  @Post()
  @Contract('POST /quality/inspection-results')
  async create(@Req() request: Request, @Body() body: InspectionResultCreate): Promise<InspectionResultView> {
    const context = await this.contextOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.writes.create(body, context));
  }

  /**
   * ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206`) — 사번의 뜻은 서비스가 가르고,
   * 단말 토큰은 «없으면 null» 이라(I-11 R-1) 있을 때만 `terminal_id` 를 채운다.
   */
  private async contextOf(request: Request): Promise<InspectionResultWriteContext> {
    const workerNo = request.headers['x-worker-no'];
    return {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      idempotencyKey: String(request.headers['idempotency-key']),
      version: ifMatchVersion(request),
      appUserId: currentSession(request)?.userId,
      terminalId: await resolveTerminalId(this.jwt, this.prisma, request),
    };
  }
}
