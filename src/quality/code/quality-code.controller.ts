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
import { CauseCodeQuery, CauseCodeService, CauseCodeWrite } from './cause-code.service';
import { DefectCodeQuery, DefectCodeService, DefectCodeWrite } from './defect-code.service';

/** 불량코드. 화면은 `W-06-03` 「불량코드」 탭이다. */
@Controller('quality/defect-codes')
export class DefectCodeController {
  constructor(
    private readonly defectCodes: DefectCodeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/defect-codes')
  list(@Query() query: DefectCodeQuery): Promise<PagedResponse<unknown>> {
    return this.defectCodes.list(query);
  }

  @Get(':defectCodeId')
  @Contract('GET /quality/defect-codes/{defectCodeId}')
  async get(
    @Param('defectCodeId', ParseIntPipe) defectCodeId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { defectCode, editability, versionNo } = await this.defectCodes.get(defectCodeId);
    setEtag(response, versionNo);
    return { defectCode, editability };
  }

  @Post()
  @Contract('POST /quality/defect-codes')
  create(@Req() request: Request, @Body() body: DefectCodeWrite): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.defectCodes.create(body),
    );
  }

  @Put(':defectCodeId')
  @Contract('PUT /quality/defect-codes/{defectCodeId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('defectCodeId', ParseIntPipe) defectCodeId: number,
    @Body() body: DefectCodeWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'defectCode', (version) =>
      this.defectCodes.update(defectCodeId, version, body),
    );
  }

  @Post(':defectCodeId\\:activate')
  @Contract('POST /quality/defect-codes/{defectCodeId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('defectCodeId', ParseIntPipe) defectCodeId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'defectCode', (version) =>
      this.defectCodes.setActive(defectCodeId, version, true),
    );
  }

  @Post(':defectCodeId\\:deactivate')
  @Contract('POST /quality/defect-codes/{defectCodeId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('defectCodeId', ParseIntPipe) defectCodeId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'defectCode', (version) =>
      this.defectCodes.setActive(defectCodeId, version, false),
    );
  }
}

/** 원인코드. 같은 화면(`W-06-03`)의 「원인코드」 탭이다 — 불량 현상과 분리 관리한다. */
@Controller('quality/cause-codes')
export class CauseCodeController {
  constructor(
    private readonly causeCodes: CauseCodeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /quality/cause-codes')
  list(@Query() query: CauseCodeQuery): Promise<PagedResponse<unknown>> {
    return this.causeCodes.list(query);
  }

  @Get(':causeCodeId')
  @Contract('GET /quality/cause-codes/{causeCodeId}')
  async get(
    @Param('causeCodeId', ParseIntPipe) causeCodeId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { causeCode, editability, versionNo } = await this.causeCodes.get(causeCodeId);
    setEtag(response, versionNo);
    return { causeCode, editability };
  }

  @Post()
  @Contract('POST /quality/cause-codes')
  create(@Req() request: Request, @Body() body: CauseCodeWrite): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.causeCodes.create(body),
    );
  }

  @Put(':causeCodeId')
  @Contract('PUT /quality/cause-codes/{causeCodeId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('causeCodeId', ParseIntPipe) causeCodeId: number,
    @Body() body: CauseCodeWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'causeCode', (version) =>
      this.causeCodes.update(causeCodeId, version, body),
    );
  }

  @Post(':causeCodeId\\:activate')
  @Contract('POST /quality/cause-codes/{causeCodeId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('causeCodeId', ParseIntPipe) causeCodeId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'causeCode', (version) =>
      this.causeCodes.setActive(causeCodeId, version, true),
    );
  }

  @Post(':causeCodeId\\:deactivate')
  @Contract('POST /quality/cause-codes/{causeCodeId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('causeCodeId', ParseIntPipe) causeCodeId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'causeCode', (version) =>
      this.causeCodes.setActive(causeCodeId, version, false),
    );
  }
}
