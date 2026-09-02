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
  AppUserCreate,
  AppUserQuery,
  AppUserService,
  AppUserUpdate,
} from './app-user.service';

/** 사용자 마스터. 화면은 `W-CO-02`(사용자·역할·권한 관리)가 소유한다. */
@Controller('app/users')
export class AppUserController {
  constructor(
    private readonly users: AppUserService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/users')
  list(@Query() query: AppUserQuery): Promise<PagedResponse<unknown>> {
    return this.users.list(query);
  }

  @Get(':appUserId')
  @Contract('GET /app/users/{appUserId}')
  async get(
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { appUser, editability, versionNo } = await this.users.get(appUserId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    return { appUser, editability };
  }

  @Post()
  @Contract('POST /app/users')
  create(@Req() request: Request, @Body() body: AppUserCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.users.create(body),
    );
  }

  @Put(':appUserId')
  @Contract('PUT /app/users/{appUserId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Body() body: AppUserUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'appUser', (version) =>
      this.users.update(appUserId, version, body),
    );
  }

  @Post(':appUserId\\:activate')
  @Contract('POST /app/users/{appUserId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('appUserId', ParseIntPipe) appUserId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'appUser', (version) =>
      this.users.setActive(appUserId, version, true),
    );
  }

  @Post(':appUserId\\:deactivate')
  @Contract('POST /app/users/{appUserId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('appUserId', ParseIntPipe) appUserId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'appUser', (version) =>
      this.users.setActive(appUserId, version, false),
    );
  }
}
