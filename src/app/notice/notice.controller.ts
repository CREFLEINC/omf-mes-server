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

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { Actor, NoticeQuery, NoticeService, NoticeWrite } from './notice.service';

/** 공지. 화면은 `W-CO-04`(공지 관리·확인)가 소유한다. */
@Controller('app/notices')
export class NoticeController {
  constructor(
    private readonly notices: NoticeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/notices')
  list(@Req() request: Request, @Query() query: NoticeQuery): Promise<PagedResponse<unknown>> {
    return this.notices.list(query, actorOf(request));
  }

  @Get(':noticeId')
  @Contract('GET /app/notices/{noticeId}')
  async get(
    @Param('noticeId', ParseIntPipe) noticeId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { notice, versionNo } = await this.notices.get(noticeId);
    setEtag(response, versionNo);
    return notice;
  }

  @Get(':noticeId/acknowledgements')
  @Contract('GET /app/notices/{noticeId}/acknowledgements')
  acknowledgements(
    @Param('noticeId', ParseIntPipe) noticeId: number,
    @Query() query: { pendingOnly?: boolean | string; page?: number; size?: number },
  ): Promise<PagedResponse<unknown>> {
    // ⚠ 질의 불리언은 문자열로도 불리언으로도 온다 — 계약 검증 가드가 선언된 형으로
    // 바꿔 줄 수 있어 한쪽만 보면 필터가 조용히 사라진다.
    return this.notices.acknowledgements(noticeId, query.pendingOnly === true || query.pendingOnly === 'true', query);
  }

  @Post()
  @Contract('POST /app/notices')
  create(@Req() request: Request, @Body() body: NoticeWrite): Promise<unknown> {
    const actor = actorOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.notices.create(body, actor),
    );
  }

  @Put(':noticeId')
  @Contract('PUT /app/notices/{noticeId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('noticeId', ParseIntPipe) noticeId: number,
    @Body() body: NoticeWrite,
  ): Promise<unknown> {
    const actor = actorOf(request);
    return runVersioned(this.idempotency, request, response, 'notice', (version) =>
      this.notices.update(noticeId, version, body, actor),
    );
  }

  @Post(':noticeId\\:publish')
  @Contract('POST /app/notices/{noticeId}:publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('noticeId', ParseIntPipe) noticeId: number,
  ): Promise<unknown> {
    const actor = actorOf(request);
    return runVersioned(this.idempotency, request, response, 'notice', (version) =>
      this.notices.publish(noticeId, version, actor),
    );
  }

  @Post(':noticeId\\:close')
  @Contract('POST /app/notices/{noticeId}:close')
  @HttpCode(HttpStatus.OK)
  close(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('noticeId', ParseIntPipe) noticeId: number,
  ): Promise<unknown> {
    const actor = actorOf(request);
    return runVersioned(this.idempotency, request, response, 'notice', (version) =>
      this.notices.close(noticeId, version, actor),
    );
  }

  @Post(':noticeId\\:acknowledge')
  @Contract('POST /app/notices/{noticeId}:acknowledge')
  @HttpCode(HttpStatus.NO_CONTENT)
  async acknowledge(
    @Req() request: Request,
    @Param('noticeId', ParseIntPipe) noticeId: number,
  ): Promise<void> {
    const actor = actorOf(request);
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.notices.acknowledge(noticeId, actor);
      return null;
    });
  }

  @Post(':noticeId\\:dismiss')
  @Contract('POST /app/notices/{noticeId}:dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(
    @Req() request: Request,
    @Param('noticeId', ParseIntPipe) noticeId: number,
  ): Promise<void> {
    const actor = actorOf(request);
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.notices.dismiss(noticeId, actor);
      return null;
    });
  }
}

/**
 * 확인 주체.
 *
 * ⚠ 계약은 현장 셸이 `X-Worker-No` 로 주체를 싣는다고 적었으나 **단말 토큰이 아직 없어**
 * 그 경로는 계정 세션 없이 들어올 수 없다(`authentication.guard.ts`). 그래서 지금은 세션
 * 사용자가 주체이고, 헤더가 함께 오면 «누가 어느 단말에서 눌렀는지»만 기록에 덧붙인다.
 * 단말 인증이 서면 주체 자체가 갈린다 — 되돌림 §Y-5.
 */
function actorOf(request: Request): Actor {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  const workerNo = header(request, 'x-worker-no');
  const workerName = header(request, 'x-worker-name');
  return {
    appUserId: session.userId,
    ...(workerNo === undefined ? {} : { workerNo }),
    ...(workerName === undefined ? {} : { workerName }),
  };
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : single;
}
