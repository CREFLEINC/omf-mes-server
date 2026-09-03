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
import {
  PutawayRuleCreate,
  PutawayRuleQuery,
  PutawayRuleService,
  PutawayRuleUpdate,
} from './putaway-rule.service';

/** 적치 규칙. 화면은 `W-06-14`(적치 규칙 마스터)가 소유한다. */
@Controller('logistics/putaway-rules')
export class PutawayRuleController {
  constructor(
    private readonly rules: PutawayRuleService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /logistics/putaway-rules')
  list(@Query() query: PutawayRuleQuery): Promise<PagedResponse<unknown>> {
    return this.rules.list(query);
  }

  /**
   * ⛔ `:putawayRuleId` 보다 «먼저» 선언한다 — Nest 는 등록 순서대로 맞추므로 뒤에 두면
   * `uncovered-items` 가 식별자로 잡혀 `ParseIntPipe` 가 400 을 낸다.
   */
  @Get('uncovered-items')
  @Contract('GET /logistics/putaway-rules/uncovered-items')
  uncovered(
    @Query('warehouseId', ParseIntPipe) warehouseId: number,
    @Query() query: { page?: number; size?: number },
  ): Promise<PagedResponse<unknown>> {
    return this.rules.uncoveredItems(warehouseId, query);
  }

  @Get(':putawayRuleId')
  @Contract('GET /logistics/putaway-rules/{putawayRuleId}')
  async get(
    @Param('putawayRuleId', ParseIntPipe) putawayRuleId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { putawayRule, editability, versionNo } = await this.rules.get(putawayRuleId);
    setEtag(response, versionNo);
    return { putawayRule, editability };
  }

  @Post()
  @Contract('POST /logistics/putaway-rules')
  create(@Req() request: Request, @Body() body: PutawayRuleCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.rules.create(body),
    );
  }

  @Put(':putawayRuleId')
  @Contract('PUT /logistics/putaway-rules/{putawayRuleId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('putawayRuleId', ParseIntPipe) putawayRuleId: number,
    @Body() body: PutawayRuleUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'putawayRule', (version) =>
      this.rules.update(putawayRuleId, version, body),
    );
  }

  @Post(':putawayRuleId\\:activate')
  @Contract('POST /logistics/putaway-rules/{putawayRuleId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('putawayRuleId', ParseIntPipe) putawayRuleId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'putawayRule', (version) =>
      this.rules.setActive(putawayRuleId, version, true),
    );
  }

  @Post(':putawayRuleId\\:deactivate')
  @Contract('POST /logistics/putaway-rules/{putawayRuleId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('putawayRuleId', ParseIntPipe) putawayRuleId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'putawayRule', (version) =>
      this.rules.setActive(putawayRuleId, version, false),
    );
  }
}
