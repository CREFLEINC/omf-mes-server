import {
  Body,
  Controller,
  Get,
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
import { MoldCreate, MoldQuery, MoldService, MoldWrite } from './mold.service';

/**
 * 툴 마스터. 화면은 `W-05-13`(툴 마스터)이 쓰고 목록은 `W-05-02`(예방보전 도래 조회)·
 * 툴 보전오더 생성 화면이 같은 경로를 필터만 바꿔 부른다.
 */
@Controller('mdm/molds')
export class MoldController {
  constructor(
    private readonly molds: MoldService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/molds')
  list(@Query() query: MoldQuery): Promise<unknown> {
    return this.molds.list(query);
  }

  @Get(':moldId')
  @Contract('GET /mdm/molds/{moldId}')
  async get(
    @Param('moldId', ParseIntPipe) moldId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { mold, editability, labelIssueCount, versionNo } = await this.molds.get(moldId);
    setEtag(response, versionNo);
    return { mold, editability, labelIssueCount };
  }

  @Post()
  @Contract('POST /mdm/molds')
  create(@Req() request: Request, @Body() body: MoldCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.molds.create(body),
    );
  }

  @Put(':moldId')
  @Contract('PUT /mdm/molds/{moldId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('moldId', ParseIntPipe) moldId: number,
    @Body() body: MoldWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'mold', (version) =>
      this.molds.update(moldId, version, body),
    );
  }
}
