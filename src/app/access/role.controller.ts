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
import { ReferenceQuery, runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { RolePermissionService } from './role-permission.service';
import { RoleService, RoleWrite } from './role.service';

/** 역할 마스터. 화면은 `W-CO-02`(사용자·역할·권한 관리)가 소유한다. */
@Controller('app/roles')
export class RoleController {
  constructor(
    private readonly roles: RoleService,
    private readonly rolePermissions: RolePermissionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/roles')
  list(@Query() query: ReferenceQuery): Promise<PagedResponse<unknown>> {
    return this.roles.list(query);
  }

  @Get(':roleId')
  @Contract('GET /app/roles/{roleId}')
  async get(
    @Param('roleId', ParseIntPipe) roleId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { role, editability, assignedUserCount, versionNo } = await this.roles.get(roleId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    return { role, editability, assignedUserCount };
  }

  @Post()
  @Contract('POST /app/roles')
  create(@Req() request: Request, @Body() body: RoleWrite): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.roles.create(body),
    );
  }

  @Put(':roleId')
  @Contract('PUT /app/roles/{roleId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() body: RoleWrite,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'role', (version) =>
      this.roles.update(roleId, version, body),
    );
  }

  @Get(':roleId/permissions')
  @Contract('GET /app/roles/{roleId}/permissions')
  async listPermissions(@Param('roleId', ParseIntPipe) roleId: number): Promise<unknown> {
    return { items: await this.rolePermissions.list(roleId) };
  }

  @Put(':roleId/permissions')
  @Contract('PUT /app/roles/{roleId}/permissions')
  async replacePermissions(
    @Req() request: Request,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() body: { permissionCodes: string[] },
  ): Promise<unknown> {
    // ⚠ 계약이 이 자리에 If-Match 를 선언하지 않았다 — 멱등 흡수만 탄다(되돌림 §Q).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.rolePermissions.replace(
        roleId,
        body.permissionCodes,
        currentSession(request)?.userId,
      ),
    }));
  }

  @Post(':roleId\\:activate')
  @Contract('POST /app/roles/{roleId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('roleId', ParseIntPipe) roleId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'role', (version) =>
      this.roles.setActive(roleId, version, true),
    );
  }

  @Post(':roleId\\:deactivate')
  @Contract('POST /app/roles/{roleId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('roleId', ParseIntPipe) roleId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'role', (version) =>
      this.roles.setActive(roleId, version, false),
    );
  }
}
