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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { LotCreate, LotQuery, LotService, LotUpdate } from './lot.service';

/** LOT. 화면은 `M-01-02`·`P-01-01` 이 만들고 여러 화면이 읽는다. */
@Controller('trace/lots')
export class LotController {
  constructor(
    private readonly lots: LotService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /trace/lots')
  list(@Query() query: LotQuery): Promise<PagedResponse<unknown>> {
    return this.lots.list(query);
  }

  @Get(':lotId')
  @Contract('GET /trace/lots/{lotId}')
  async get(
    @Param('lotId', ParseIntPipe) lotId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { detail, versionNo } = await this.lots.get(lotId);
    setEtag(response, versionNo);
    return detail;
  }

  @Post()
  @Contract('POST /trace/lots')
  create(@Req() request: Request, @Body() body: LotCreate): Promise<unknown> {
    const userId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.lots.create(body, userId),
    );
  }

  @Put(':lotId')
  @Contract('PUT /trace/lots/{lotId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('lotId', ParseIntPipe) lotId: number,
    @Body() body: LotUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'detail', (version) =>
      this.lots.update(lotId, version, body),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
