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
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { InspectionSheetAccess } from '../inspection-sheet/inspection-sheet-access';
import { InspectionSheetTemplateView } from './inspection-sheet-template-view';
import {
  InspectionSheetTemplateCreate,
  InspectionSheetTemplateQuery,
  InspectionSheetTemplateService,
  InspectionSheetTemplateUpdate,
  TemplateActor,
} from './inspection-sheet-template.service';

/** OA 제품 검사표 기준. 화면은 `W-06-24`(검사표 기준)가 소유한다(장부 P-102). */
@Controller('quality/inspection-sheet-templates')
export class InspectionSheetTemplateController {
  constructor(
    private readonly templates: InspectionSheetTemplateService,
    private readonly access: InspectionSheetAccess,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-sheet-templates')
  async list(
    @Req() request: Request,
    @Query() query: InspectionSheetTemplateQuery,
  ): Promise<PagedResponse<InspectionSheetTemplateView>> {
    await this.access.plantsOf(request);
    return this.templates.list(query);
  }

  @Get(':inspectionSheetTemplateId')
  @Contract('GET /quality/inspection-sheet-templates/{inspectionSheetTemplateId}')
  async get(
    @Req() request: Request,
    @Param('inspectionSheetTemplateId', ParseIntPipe) id: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InspectionSheetTemplateView> {
    await this.access.plantsOf(request);
    const { inspectionSheetTemplate, versionNo } = await this.templates.get(id);
    setEtag(response, versionNo);
    return inspectionSheetTemplate;
  }

  @Post()
  @Contract('POST /quality/inspection-sheet-templates')
  async create(@Req() request: Request, @Body() body: InspectionSheetTemplateCreate): Promise<InspectionSheetTemplateView> {
    const actor = actorOf(request);
    await this.access.plantsOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.templates.create(body, actor));
  }

  @Put(':inspectionSheetTemplateId')
  @Contract('PUT /quality/inspection-sheet-templates/{inspectionSheetTemplateId}')
  async update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetTemplateId', ParseIntPipe) id: number,
    @Body() body: InspectionSheetTemplateUpdate,
  ): Promise<InspectionSheetTemplateView> {
    const actor = actorOf(request);
    await this.access.plantsOf(request);
    return runVersioned<InspectionSheetTemplateView, 'inspectionSheetTemplate'>(
      this.idempotency,
      request,
      response,
      'inspectionSheetTemplate',
      (version) => this.templates.update(id, version, body, actor),
    );
  }

  @Post(':inspectionSheetTemplateId\\:confirm')
  @Contract('POST /quality/inspection-sheet-templates/{inspectionSheetTemplateId}:confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetTemplateId', ParseIntPipe) id: number,
  ): Promise<InspectionSheetTemplateView> {
    const actor = actorOf(request);
    await this.access.plantsOf(request);
    return runVersioned<InspectionSheetTemplateView, 'inspectionSheetTemplate'>(
      this.idempotency,
      request,
      response,
      'inspectionSheetTemplate',
      (version) => this.templates.confirm(id, version, actor),
    );
  }

  @Post(':inspectionSheetTemplateId\\:obsolete')
  @Contract('POST /quality/inspection-sheet-templates/{inspectionSheetTemplateId}:obsolete')
  @HttpCode(HttpStatus.OK)
  async obsolete(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionSheetTemplateId', ParseIntPipe) id: number,
  ): Promise<InspectionSheetTemplateView> {
    const actor = actorOf(request);
    await this.access.plantsOf(request);
    return runVersioned<InspectionSheetTemplateView, 'inspectionSheetTemplate'>(
      this.idempotency,
      request,
      response,
      'inspectionSheetTemplate',
      (version) => this.templates.obsolete(id, version, actor),
    );
  }

  @Delete(':inspectionSheetTemplateId')
  @Contract('DELETE /quality/inspection-sheet-templates/{inspectionSheetTemplateId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(@Req() request: Request, @Param('inspectionSheetTemplateId', ParseIntPipe) id: number): Promise<void> {
    const actor = actorOf(request);
    await this.access.plantsOf(request);
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.templates.discard(id, actor);
      return undefined;
    });
  }
}

function actorOf(request: Request): TemplateActor {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return { userId: session.userId };
}
