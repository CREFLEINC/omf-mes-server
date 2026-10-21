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
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminalInspectionSheetWorkerId } from '../../auth/terminal-inspection-sheet-scope';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { SheetActor } from '../../core/inspection-sheet';
import {
  InspectionSheetEntryService,
  InspectionSheetHeaderUpdate,
  InspectionSheetNgWrite,
  InspectionSheetStepWrite,
} from './inspection-sheet-entry.service';
import { InspectionSheetListQuery, InspectionSheetQueryService, InspectionSheetSummaryView } from './inspection-sheet-query.service';
import { InspectionSheetAccess } from './inspection-sheet-access';
import { InspectionSheetSignService } from './inspection-sheet-sign.service';
import { InspectionSheetView } from './inspection-sheet-view';
import { PagedResponse } from '../../common/pagination';

/** OA 제품 검사표 입력 — POP `P-02-15`(제품 검사표 입력) · 관리웹 `W-03-13`(제품 검사표 조회·출력)(장부 P-102). */
@Controller('quality/inspection-sheets')
export class InspectionSheetController {
  constructor(
    private readonly entries: InspectionSheetEntryService,
    private readonly signs: InspectionSheetSignService,
    private readonly queries: InspectionSheetQueryService,
    private readonly access: InspectionSheetAccess,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-sheets')
  async list(
    @Req() request: Request,
    @Query() query: InspectionSheetListQuery,
  ): Promise<PagedResponse<InspectionSheetSummaryView>> {
    return this.queries.list(query, await this.access.plantsOf(request));
  }

  @Post(':inspectionSheetId/steps/:stepCode\\:sign')
  @Contract('POST /quality/inspection-sheets/{inspectionSheetId}/steps/{stepCode}:sign')
  @HttpCode(HttpStatus.OK)
  async signStep(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Param('stepCode') stepCode: string,
  ): Promise<InspectionSheetView> {
    const actorId = managerOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.signs.signStep(id, stepCode, version, actorId),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Post(':inspectionSheetId\\:approve')
  @Contract('POST /quality/inspection-sheets/{inspectionSheetId}:approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
  ): Promise<InspectionSheetView> {
    const actorId = managerOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.signs.decide(id, 'APPROVE', version, actorId),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Post(':inspectionSheetId\\:check')
  @Contract('POST /quality/inspection-sheets/{inspectionSheetId}:check')
  @HttpCode(HttpStatus.OK)
  async check(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
  ): Promise<InspectionSheetView> {
    const actorId = managerOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.signs.decide(id, 'CHECK', version, actorId),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Post(':inspectionSheetId\\:reopen')
  @Contract('POST /quality/inspection-sheets/{inspectionSheetId}:reopen')
  @HttpCode(HttpStatus.OK)
  async reopen(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Body() body: { reason: string },
  ): Promise<InspectionSheetView> {
    const actorId = managerOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.signs.reopen(id, version, body.reason, actorId),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Get(':inspectionSheetId')
  @Contract('GET /quality/inspection-sheets/{inspectionSheetId}')
  async get(
    @Req() request: Request,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InspectionSheetView> {
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    const { inspectionSheet, versionNo } = await this.entries.get(id);
    setEtag(response, versionNo);
    return inspectionSheet;
  }

  @Put(':inspectionSheetId/header')
  @Contract('PUT /quality/inspection-sheets/{inspectionSheetId}/header')
  async updateHeader(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Body() body: InspectionSheetHeaderUpdate,
  ): Promise<InspectionSheetView> {
    const actor = actorOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.entries.updateHeader(id, version, body, actor),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Put(':inspectionSheetId/steps/:stepCode')
  @Contract('PUT /quality/inspection-sheets/{inspectionSheetId}/steps/{stepCode}')
  async writeStep(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Param('stepCode') stepCode: string,
    @Body() body: InspectionSheetStepWrite,
  ): Promise<InspectionSheetView> {
    const actor = actorOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.entries.writeStep(id, stepCode, version, body, actor),
      FAMILY_CONFLICT_CODE,
    );
  }

  @Put(':inspectionSheetId/ngs')
  @Contract('PUT /quality/inspection-sheets/{inspectionSheetId}/ngs')
  async replaceNgs(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetId', ParseIntPipe) id: number,
    @Body() body: { ngs: InspectionSheetNgWrite[] },
  ): Promise<InspectionSheetView> {
    const actor = actorOf(request);
    await this.access.assertSheet(id, await this.access.plantsOf(request));
    return runVersioned<InspectionSheetView, 'inspectionSheet'>(
      this.idempotency,
      request,
      response,
      'inspectionSheet',
      (version) => this.entries.replaceNgs(id, version, body.ngs, actor),
      FAMILY_CONFLICT_CODE,
    );
  }
}

/**
 * ⛔ 컬렉션 액션(`/inspection-sheets:open-by-serial`)은 접두어를 한 단계 위로 잡는다 — `MoldImportController` 와 같은 이유.
 */
@Controller('quality')
export class InspectionSheetOpenController {
  constructor(
    private readonly entries: InspectionSheetEntryService,
    private readonly access: InspectionSheetAccess,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('inspection-sheets\\:open-by-serial')
  @Contract('POST /quality/inspection-sheets:open-by-serial')
  @HttpCode(HttpStatus.OK)
  async openBySerial(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: { serialNo: string },
  ): Promise<InspectionSheetView> {
    const actor = actorOf(request);
    await this.access.assertSerial(body.serialNo, await this.access.plantsOf(request));
    const result = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.entries.openBySerial(body.serialNo, actor),
    );
    setEtag(response, result.versionNo);
    return result.inspectionSheet;
  }
}

/** POP 은 단말 범위가 사번으로 정한 작업자, 관리웹은 세션 계정이 쓰는 사람이다. */
function actorOf(request: Request): SheetActor {
  const workerId = currentTerminalInspectionSheetWorkerId(request);
  if (workerId !== undefined) return { workerId };
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return { appUserId: BigInt(session.userId) };
}

/** 서명·승인은 관리웹 계정만 — 이름·시각이 서명이다(담당자 결정 ②). 단말 요청은 여기 닿지 않는다(단말 범위 밖). */
function managerOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
