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
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { CredentialService } from '../../auth/credential.service';
import { currentSession } from '../../auth/session-resolver.service';
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
import { ScopeInput, UserAssignmentService } from './user-assignment.service';

/** 사용자 마스터. 화면은 `W-CO-02`(사용자·역할·권한 관리)가 소유한다. */
@Controller('app/users')
export class AppUserController {
  constructor(
    private readonly users: AppUserService,
    private readonly assignments: UserAssignmentService,
    private readonly credentials: CredentialService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * 내 비밀번호 변경. 경로가 `me:change-password` 한 마디라 컨트롤러 접두어 아래 그대로
   * 붙는다 — 컬렉션 액션(`/molds:import`)처럼 한 단계 위로 뺄 필요가 없다.
   *
   * ⛔ 세션의 사용자로만 바꾼다. 대상 id 를 받지 않는 것이 「내」의 뜻이다 — 받으면 남의
   * 비밀번호를 바꾸는 길이 열린다.
   */
  @Post('me\\:change-password')
  @Contract('POST /app/users/me:change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Req() request: Request,
    @Body() body: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.credentials.changePassword(session.userId, body.currentPassword, body.newPassword);
      return null;
    });
  }

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

  @Get(':appUserId/roles')
  @Contract('GET /app/users/{appUserId}/roles')
  async listRoles(@Param('appUserId', ParseIntPipe) appUserId: number): Promise<unknown> {
    return { items: await this.assignments.listRoles(appUserId) };
  }

  @Put(':appUserId/roles')
  @Contract('PUT /app/users/{appUserId}/roles')
  async replaceRoles(
    @Req() request: Request,
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Body() body: { roleIds: number[] },
  ): Promise<unknown> {
    // ⚠ 계약이 이 자리에 If-Match 를 선언하지 않았다 — 멱등 흡수만 탄다(되돌림 §Q).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.assignments.replaceRoles(
        appUserId,
        body.roleIds,
        currentSession(request)?.userId,
      ),
    }));
  }

  @Get(':appUserId/data-scopes')
  @Contract('GET /app/users/{appUserId}/data-scopes')
  async listScopes(@Param('appUserId', ParseIntPipe) appUserId: number): Promise<unknown> {
    return { items: await this.assignments.listScopes(appUserId) };
  }

  @Put(':appUserId/data-scopes')
  @Contract('PUT /app/users/{appUserId}/data-scopes')
  async replaceScopes(
    @Req() request: Request,
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Body() body: { scopes: ScopeInput[] },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.assignments.replaceScopes(
        appUserId,
        body.scopes,
        currentSession(request)?.userId,
      ),
    }));
  }

  @Post(':appUserId\\:reset-password')
  @Contract('POST /app/users/{appUserId}:reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Req() request: Request,
    @Param('appUserId', ParseIntPipe) appUserId: number,
  ): Promise<unknown> {
    // ⛔ 임시 비밀번호는 «이 응답에서 한 번만» 보인다. 멱등 재전송은 저장된 앞의 응답을
    // 그대로 돌려준다 — 새로 뽑으면 앞에 알려 준 값이 조용히 무효가 된다.
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.assignments.resetPassword(appUserId, currentSession(request)?.userId),
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
