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
import {
  InspectionPlanVersionService,
  ItemSpecUpsert,
  VersionCreate,
  VersionWrite,
} from './inspection-plan-version.service';

/** 검사기준 버전. 화면은 `W-06-02` 의 버전 목록·상세·항목 격자다. */
@Controller('quality/inspection-plan-versions')
export class InspectionPlanVersionController {
  constructor(
    private readonly versions: InspectionPlanVersionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/inspection-plan-versions')
  async list(@Query('inspectionPlanId', ParseIntPipe) inspectionPlanId: number): Promise<unknown> {
    return { items: await this.versions.list(inspectionPlanId) };
  }

  @Get(':inspectionPlanVersionId')
  @Contract('GET /quality/inspection-plan-versions/{inspectionPlanVersionId}')
  async get(
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { inspectionPlanVersion, editability, versionNo } = await this.versions.get(versionId);
    setEtag(response, versionNo);
    return { inspectionPlanVersion, editability };
  }

  @Post()
  @Contract('POST /quality/inspection-plan-versions')
  create(@Req() request: Request, @Body() body: VersionCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.versions.create(body),
    );
  }

  @Put(':inspectionPlanVersionId')
  @Contract('PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @Body() body: VersionWrite,
  ): Promise<unknown> {
    return runVersioned(
      this.idempotency,
      request,
      response,
      'inspectionPlanVersion',
      (version) => this.versions.update(versionId, version, body),
    );
  }

  @Get(':inspectionPlanVersionId/items')
  @Contract('GET /quality/inspection-plan-versions/{inspectionPlanVersionId}/items')
  async listItems(
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
  ): Promise<unknown> {
    return { items: await this.versions.listItems(versionId) };
  }

  @Put(':inspectionPlanVersionId/items')
  @Contract('PUT /quality/inspection-plan-versions/{inspectionPlanVersionId}/items')
  async replaceItems(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
    @Body() body: { items: ItemSpecUpsert[] },
  ): Promise<unknown> {
    // ⚠ 「컬렉션 전체 치환이라 IfMatchVersion 을 쓰지 않는다 — 409 는 없다」(계약).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.versions.replaceItems(versionId, body.items),
    }));
  }

  @Post(':inspectionPlanVersionId\\:confirm')
  @Contract('POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () =>
      this.header(await this.versions.confirm(versionId)),
    );
  }

  @Post(':inspectionPlanVersionId\\:obsolete')
  @Contract('POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:obsolete')
  @HttpCode(HttpStatus.OK)
  obsolete(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () =>
      this.header(await this.versions.obsolete(versionId)),
    );
  }

  @Post(':inspectionPlanVersionId\\:new-revision')
  @Contract('POST /quality/inspection-plan-versions/{inspectionPlanVersionId}:new-revision')
  @HttpCode(HttpStatus.CREATED)
  newRevision(
    @Req() request: Request,
    @Param('inspectionPlanVersionId', ParseIntPipe) versionId: number,
  ): Promise<unknown> {
    // ⛔ 201 이다 — 새 버전이 «생긴다». 멱등 재전송이 같은 버전을 돌려줘야 한다.
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () =>
      this.header(await this.versions.newRevision(versionId)),
    );
  }

  /** 전이·발행은 헤더만 낸다 — 「응답은 헤더(버전)만 반환한다」(계약). */
  private async header(versionId: number): Promise<unknown> {
    const { inspectionPlanVersion } = await this.versions.get(versionId);
    return inspectionPlanVersion;
  }
}
