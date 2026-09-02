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
import {
  DependencyInput,
  RoutingOperationService,
  RoutingOperationUpsert,
} from './routing-operation.service';
import { RoutingRevisionService } from './routing-revision.service';
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
    private readonly operations: RoutingOperationService,
    private readonly revisions: RoutingRevisionService,
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

  @Get(':routingId/operations')
  @Contract('GET /planning/routings/{routingId}/operations')
  async listOperations(@Param('routingId', ParseIntPipe) routingId: number): Promise<unknown> {
    return { items: await this.operations.list(routingId) };
  }

  @Put(':routingId/operations')
  @Contract('PUT /planning/routings/{routingId}/operations')
  async replaceOperations(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() body: { operations: RoutingOperationUpsert[] },
  ): Promise<unknown> {
    // ⚠ 「컬렉션 전체 치환이라 IfMatchVersion 을 쓰지 않는다 — 409 는 없다」(계약).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.operations.replace(routingId, body.operations),
    }));
  }

  @Get(':routingId/operation-dependencies')
  @Contract('GET /planning/routings/{routingId}/operation-dependencies')
  async listDependencies(@Param('routingId', ParseIntPipe) routingId: number): Promise<unknown> {
    return { items: await this.operations.listDependencies(routingId) };
  }

  @Put(':routingId/operation-dependencies')
  @Contract('PUT /planning/routings/{routingId}/operation-dependencies')
  async replaceDependencies(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
    @Body() body: { dependencies: DependencyInput[] },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.operations.replaceDependencies(
        routingId,
        body.dependencies,
        currentSession(request)?.userId,
      ),
    }));
  }

  @Post(':routingId\\:confirm')
  @Contract('POST /planning/routings/{routingId}:confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
  ): Promise<unknown> {
    // ⚠ 계약이 이 자리에 If-Match 를 선언하지 않았다 — 상태 전이가 판정을 대신한다.
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () =>
      this.header(await this.revisions.confirm(routingId)),
    );
  }

  @Post(':routingId\\:obsolete')
  @Contract('POST /planning/routings/{routingId}:obsolete')
  @HttpCode(HttpStatus.OK)
  obsolete(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () =>
      this.header(await this.revisions.obsolete(routingId)),
    );
  }

  @Post(':routingId\\:new-revision')
  @Contract('POST /planning/routings/{routingId}:new-revision')
  @HttpCode(HttpStatus.CREATED)
  newRevision(
    @Req() request: Request,
    @Param('routingId', ParseIntPipe) routingId: number,
  ): Promise<unknown> {
    // ⛔ 201 이다 — 새 Rev 가 «생긴다». 멱등 재전송이 같은 Rev 를 돌려줘야 한다.
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () =>
      this.header(await this.revisions.newRevision(routingId)),
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

  /** 전이·발행은 헤더만 낸다 — 「응답은 헤더만 반환한다」(계약). */
  private async header(routingId: number): Promise<unknown> {
    const { routing } = await this.routings.get(routingId);
    return routing;
  }
}
