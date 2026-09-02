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
  RoutingCreate,
  RoutingQuery,
  RoutingService,
  RoutingUpdate,
} from './routing.service';

/** Routing(공정 순서) 헤더. 화면은 `W-06-01`(Routing 등록·관리)이 소유한다. */
@Controller('planning/routings')
export class RoutingController {
  constructor(
    private readonly routings: RoutingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /planning/routings')
  async list(@Query() query: RoutingQuery): Promise<unknown> {
    return { items: await this.routings.list(query) };
  }

  @Get(':routingId')
  @Contract('GET /planning/routings/{routingId}')
  async get(
    @Param('routingId', ParseIntPipe) routingId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { routing, editability, versionNo } = await this.routings.get(routingId);
    setEtag(response, versionNo);
    return { routing, editability };
  }

  @Post()
  @Contract('POST /planning/routings')
  create(@Req() request: Request, @Body() body: RoutingCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.routings.create(body),
    );
  }

  @Put(':routingId')
  @Contract('PUT /planning/routings/{routingId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() body: RoutingUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'routing', (version) =>
      this.routings.update(routingId, version, body),
    );
  }

  @Post(':routingId\\:set-default')
  @Contract('POST /planning/routings/{routingId}:set-default')
  @HttpCode(HttpStatus.OK)
  async setDefault(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
  ): Promise<unknown> {
    // ⚠ 계약이 이 자리에 If-Match 를 선언하지 않았다 — 기본 Rev 지정은 같은 품목의 «두»
    // 행을 함께 움직이므로 한 행의 버전으로 가릴 수 있는 저장이 아니다.
    const { routing } = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.routings.setDefault(routingId),
    );
    return routing;
  }
}
