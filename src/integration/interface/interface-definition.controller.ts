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
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  DefinitionCreate,
  DefinitionQuery,
  DefinitionWrite,
  InterfaceDefinitionService,
} from './interface-definition.service';

/** 연계 정의. 화면은 `W-06-09`(ERP-MES I/F 연계정의 관리)가 소유한다. */
@Controller('integration/interface-definitions')
export class InterfaceDefinitionController {
  constructor(
    private readonly definitions: InterfaceDefinitionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /integration/interface-definitions')
  list(@Query() query: DefinitionQuery): Promise<PagedResponse<unknown>> {
    return this.definitions.list(query);
  }

  @Get(':interfaceDefinitionId')
  @Contract('GET /integration/interface-definitions/{interfaceDefinitionId}')
  async get(
    @Param('interfaceDefinitionId', ParseIntPipe) definitionId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { interfaceDefinition, columnMappings, editability, pendingMessageCount, versionNo } =
      await this.definitions.get(definitionId);
    setEtag(response, versionNo);
    return { interfaceDefinition, columnMappings, editability, pendingMessageCount };
  }

  @Post()
  @Contract('POST /integration/interface-definitions')
  create(@Req() request: Request, @Body() body: DefinitionCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.definitions.create(body, currentSession(request)?.userId),
    );
  }

  @Put(':interfaceDefinitionId')
  @Contract('PUT /integration/interface-definitions/{interfaceDefinitionId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('interfaceDefinitionId', ParseIntPipe) definitionId: number,
    @Body() body: DefinitionWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'interfaceDefinition', (version) =>
      this.definitions.update(definitionId, version, body, currentSession(request)?.userId),
    );
  }

  @Post(':interfaceDefinitionId\\:activate')
  @Contract('POST /integration/interface-definitions/{interfaceDefinitionId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('interfaceDefinitionId', ParseIntPipe) definitionId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'interfaceDefinition', (version) =>
      this.definitions.setActive(definitionId, version, true),
    );
  }

  @Post(':interfaceDefinitionId\\:deactivate')
  @Contract('POST /integration/interface-definitions/{interfaceDefinitionId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('interfaceDefinitionId', ParseIntPipe) definitionId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'interfaceDefinition', (version) =>
      this.definitions.setActive(definitionId, version, false),
    );
  }

  @Post(':interfaceDefinitionId\\:test-connection')
  @Contract('POST /integration/interface-definitions/{interfaceDefinitionId}:test-connection')
  @HttpCode(HttpStatus.OK)
  testConnection(
    @Req() request: Request,
    @Param('interfaceDefinitionId', ParseIntPipe) definitionId: number,
  ): Promise<unknown> {
    // ⚠ 계약이 이 자리에 If-Match 를 선언하지 않았다 — 아무것도 바꾸지 않는 시험이다.
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.definitions.testConnection(definitionId),
    );
  }
}
