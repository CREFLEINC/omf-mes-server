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
import { ReferenceQuery, runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ProcessService, ProcessWrite } from './process.service';

/** 공정 마스터. 화면은 `W-06-01` 《공정 마스터》 탭 §4-D·§5-1 이다. */
@Controller('mdm/processes')
export class ProcessController {
  constructor(
    private readonly processes: ProcessService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/processes')
  list(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.processes.list(query);
  }

  @Get(':processId')
  @Contract('GET /mdm/processes/{processId}')
  async get(
    @Param('processId', ParseIntPipe) processId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { process, editability, versionNo } = await this.processes.get(processId);
    setEtag(response, versionNo);
    return { process, editability };
  }

  @Post()
  @Contract('POST /mdm/processes')
  create(@Req() request: Request, @Body() body: ProcessWrite): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.processes.create(body),
    );
  }

  @Put(':processId')
  @Contract('PUT /mdm/processes/{processId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('processId', ParseIntPipe) processId: number,
    @Body() body: ProcessWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'process', (version) =>
      this.processes.update(processId, version, body),
    );
  }

  @Post(':processId\\:activate')
  @Contract('POST /mdm/processes/{processId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('processId', ParseIntPipe) processId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'process', (version) =>
      this.processes.setActive(processId, version, true),
    );
  }

  @Post(':processId\\:deactivate')
  @Contract('POST /mdm/processes/{processId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('processId', ParseIntPipe) processId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'process', (version) =>
      this.processes.setActive(processId, version, false),
    );
  }
}
