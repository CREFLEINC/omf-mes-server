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
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { resolveTerminalId } from '../../auth/terminal-token';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionConfirmService, InspectionResultConfirm } from './inspection-confirm.service';
import { InspectionResultListQuery, InspectionResultQueryService } from './inspection-result-query.service';
import {
  InspectionResultCreate,
  InspectionResultUpdate,
  InspectionResultWriteContext,
  InspectionResultWriteService,
} from './inspection-result-write.service';
import { InspectionResultView } from './inspection-result-view';

/**
 * 검사 결과 조회 2건(I-19 PR ②b) + 저장(PR ③b)·수정(PR ③c)·**확정(PR ④)**.
 * `summary`·`defect-rate-trend`·`measurement-summary`·`/measurements` 는
 * `InspectionSummaryController` 에 있다(PR ⑤a·⑤b · R-18) — 그쪽이 `quality.module.ts` 의
 * `controllers` 배열에서 **이 컨트롤러보다 먼저** 등록돼 있다. `ParseIntPipe` 가 `'summary'` 를 숫자로 못 읽어 400 을 내는
 * 함정은 컨트롤러를 나눠도 라우트 등록 «순서»에는 그대로 남기 때문이다.
 * ⛔ 403 게이트는 `derived-permissions.ts:250-251·280` 에 세 자리가 이미 있다 — `manual-permissions.ts` 0줄.
 */
@Controller('quality/inspection-results')
export class InspectionResultController {
  constructor(
    private readonly results: InspectionResultQueryService,
    private readonly writes: InspectionResultWriteService,
    private readonly confirms: InspectionConfirmService,
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
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.writes.create(body, context), FAMILY_CONFLICT_CODE);
  }

  /**
   * 수정. If-Match 는 **필수**(`IfMatchVersion`)라 가드가 이미 막았다 — `runVersioned` 를 그대로 쓴다.
   * ⚠ 계약이 200 에 **ETag 를 선언하지 않았는데** `runVersioned` 는 늘 낸다. I-1 「알려둘 것」
   *   (`PUT …/steps` 가 같은 자리)과 같은 모양이라 반복 기재하고 **고치지 않는다** — 선언 안 한
   *   헤더를 더 내리는 것은 호환 완화이고, 다음 쓰기의 If-Match 를 화면이 여기서 얻는다.
   */
  @Put(':inspectionResultId')
  @Contract('PUT /quality/inspection-results/{inspectionResultId}')
  async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionResultId', ParseIntPipe) inspectionResultId: number,
    @Body() body: InspectionResultUpdate,
  ): Promise<InspectionResultView> {
    const context = await this.contextOf(request);
    return runVersioned<InspectionResultView, 'view'>(this.idempotency, request, response, 'view', (version) =>
      this.writes.update(inspectionResultId, version, body, context), FAMILY_CONFLICT_CODE);
  }

  /**
   * ⭐ 판정 확정. 한 트랜잭션 안에서 LOT 품질 축 전이·보류 해제·C14 가 함께 일어난다(§3-1).
   * If-Match 는 **필수**(`IfMatchVersion`)라 가드가 이미 막았다 — `runVersioned` 를 그대로 쓴다.
   * ⚠ `PUT` 과 같은 자리 — 계약이 200 에 ETag 를 선언하지 않았는데 `runVersioned` 는 늘 낸다
   *   (「알려둘 것」 · 확정 뒤 화면이 다음 쓰기의 토큰을 여기서 얻는다).
   * ⛔ `X-Worker-No` 를 안 읽는다 — 계약이 이 자리에 그 헤더를 선언하지 않았고(§1-1) 확정
   *   주체는 `lot_status_event.changed_by`(NOT NULL)라 **계정 세션**이 유일한 원천이다.
   */
  @Post(':inspectionResultId\\:confirm')
  @Contract('POST /quality/inspection-results/{inspectionResultId}:confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionResultId', ParseIntPipe) inspectionResultId: number,
    @Body() body: InspectionResultConfirm,
  ): Promise<InspectionResultView> {
    const appUserId = userOf(request);
    return runVersioned<InspectionResultView, 'view'>(this.idempotency, request, response, 'view', (version) =>
      this.confirms.confirm(inspectionResultId, version, body, appUserId), FAMILY_CONFLICT_CODE);
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

/** `lot_status_event.changed_by` 가 NOT NULL 이라 확정에는 계정 세션이 반드시 있어야 한다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
