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
import { SessionResolver, currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  AppUserCreate,
  AppUserQuery,
  AppUserService,
  AppUserUpdate,
  PHONE_VISIBLE_PERMISSION,
  withoutPhone,
} from './app-user.service';
import { ScopeInput, UserAssignmentService } from './user-assignment.service';
import { UserWorkerLinkService } from './user-worker-link.service';

/** 사용자 마스터. 화면은 `W-CO-02`(사용자·역할·권한 관리)가 소유한다. */
@Controller('app/users')
export class AppUserController {
  constructor(
    private readonly users: AppUserService,
    private readonly assignments: UserAssignmentService,
    private readonly workerLinks: UserWorkerLinkService,
    private readonly credentials: CredentialService,
    private readonly sessionResolver: SessionResolver,
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
    @Res({ passthrough: true }) response: Response,
    @Body() body: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.credentials.changePassword(session.userId, body.currentPassword, body.newPassword);
      return null;
    });
    // 변경 시각이 올라 이 쿠키도 「변경 전 발급」이 됐다 — 바꾼 본인은 새 쿠키로 살린다.
    await this.sessionResolver.reissue(request, response);
  }

  /**
   * ⛔ 결재선·결재함 권한으로도 열리는 목록이라 휴대폰 번호는 `W-CO-02` 가 있을 때만 싣는다.
   * 쓰기 경로(등록·수정·전이)는 `W-CO-02` 로만 열려 그대로 둔다.
   */
  @Get()
  @Contract('GET /app/users')
  async list(@Req() request: Request, @Query() query: AppUserQuery): Promise<PagedResponse<unknown>> {
    const page = await this.users.list(query);
    if (canSeePhone(request)) return page;
    return { ...page, items: page.items.map(withoutPhone) };
  }

  @Get(':appUserId')
  @Contract('GET /app/users/{appUserId}')
  async get(
    @Req() request: Request,
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    // 계약이 이 상세 조회에 403 을 선언하지 않아 PermissionGuard 가 건너뛴다.
    // 본인 이외의 사용자 상세는 사용자 관리 권한으로 명시적으로 보호한다(P-6).
    if (session.userId !== appUserId && !session.permissions.includes('W-CO-02')) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '이 기능을 쓸 권한이 없습니다.' },
      ]);
    }

    const { appUser, editability, versionNo } = await this.users.get(appUserId);
    // 본인 조회는 W-CO-02 가 없어도 열린다 — 번호는 그래도 W-CO-02 몫이다.
    const shown = canSeePhone(request) ? appUser : withoutPhone(appUser);
    // 개인정보 응답은 브라우저에 저장하지 않는다. 예전 버전 ETag 의 조건부 요청도
    // Express 가 304 로 바꾸지 못하게 무시하고, 항상 현재 본문을 다시 보낸다.
    response.setHeader('Cache-Control', 'private, no-store');
    delete request.headers['if-none-match'];
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    return { appUser: shown, editability };
  }

  /**
   * ⛔ 비밀번호를 안 보내면 서버가 뽑은 임시 비밀번호가 «이 응답에서 한 번만» 보인다.
   * 멱등 재전송이 저장된 앞의 응답을 그대로 돌려주는 것도 `:reset-password` 와 같다.
   */
  @Post()
  @Contract('POST /app/users')
  create(@Req() request: Request, @Body() body: AppUserCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.users.create(body, currentSession(request)?.userId),
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

  /** 계정에 연결된 작업자(omf-all-around#104 · 장부 P-38). 연결이 없으면 세 칸이 `null` 이다. */
  @Get(':appUserId/worker')
  @Contract('GET /app/users/{appUserId}/worker')
  getWorker(@Param('appUserId', ParseIntPipe) appUserId: number): Promise<unknown> {
    return this.workerLinks.get(appUserId);
  }

  /** 연결 치환 — `workerId: null` 이면 해제다. ⚠ If-Match 를 두지 않는다(역할 치환과 같은 모양). */
  @Put(':appUserId/worker')
  @Contract('PUT /app/users/{appUserId}/worker')
  replaceWorker(
    @Req() request: Request,
    @Param('appUserId', ParseIntPipe) appUserId: number,
    @Body() body: { workerId: number | null },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.workerLinks.replace(appUserId, body.workerId, currentSession(request)?.userId),
    );
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
  async resetPassword(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('appUserId', ParseIntPipe) appUserId: number,
  ): Promise<unknown> {
    const actorId = currentSession(request)?.userId;
    // ⛔ 임시 비밀번호는 «이 응답에서 한 번만» 보인다. 멱등 재전송은 저장된 앞의 응답을
    // 그대로 돌려준다 — 새로 뽑으면 앞에 알려 준 값이 조용히 무효가 된다.
    const result = await runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.assignments.resetPassword(appUserId, actorId),
    );
    // 초기화는 그 계정의 기존 로그인을 전부 끊는다(`issuedBeforePasswordChange`). 자기 계정을
    // 초기화한 관리자는 지금 이 창에서 임시 비밀번호를 읽어야 하므로 이 세션만 살린다.
    if (actorId === appUserId) await this.sessionResolver.reissue(request, response);
    return result;
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

function canSeePhone(request: Request): boolean {
  return currentSession(request)?.permissions.includes(PHONE_VISIBLE_PERMISSION) === true;
}
