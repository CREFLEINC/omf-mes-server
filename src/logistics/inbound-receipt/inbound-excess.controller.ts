import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { loginRequired } from '../../auth/authentication.guard';
import { attachSession, SessionResolver } from '../../auth/session-resolver.service';
import type { Session } from '../../auth/session.types';
import { PagedResponse } from '../../common/pagination';
import { assertOperationPermission } from '../../common/permissions';
import {
  ExcessCandidateView,
  InboundExcessView,
  parseExcessId,
  parseExcessQuery,
  parseLinkBody,
} from './inbound-excess';
import { InboundExcessService } from './inbound-excess.service';

/** 초과분은 초과 입하 분리 화면(W-01-03)의 일이다 — 보기·잇기 모두 그 화면 권한으로 본다. */
const OPERATION = 'POST /logistics/inbound-receipts:split';

/**
 * 입하 초과분 잇기(장부 P-96). ⛔ 이 경로들은 계약 사본에 없어 `@Contract` 를 달 수 없고, 그래서 인증·권한 가드가
 * 이 핸들러를 보지 않는다. 가드가 쓰는 같은 함수(세션 해석 · 로그인 필요 401 · 오퍼레이션 권한 403)를 여기서 부른다
 * (P-58 과 같은 길). 정본에 경로가 실려 오면 `@Contract` 를 달고 이 수동 인증·검사를 지운다.
 */
@Controller('logistics/inbound-excesses')
export class InboundExcessController {
  constructor(
    private readonly resolver: SessionResolver,
    private readonly excesses: InboundExcessService,
  ) {}

  @Get()
  async list(@Req() request: Request, @Query() query: Record<string, unknown>): Promise<PagedResponse<InboundExcessView>> {
    await this.authorize(request);
    return this.excesses.list(parseExcessQuery(query));
  }

  @Get(':inboundReceiptExcessId/candidates')
  async candidates(@Req() request: Request, @Param('inboundReceiptExcessId') id: string): Promise<{ items: ExcessCandidateView[] }> {
    await this.authorize(request);
    return { items: await this.excesses.candidates(parseExcessId(id)) };
  }

  @Post(':inboundReceiptExcessId\\:link')
  @HttpCode(HttpStatus.OK)
  async link(
    @Req() request: Request,
    @Param('inboundReceiptExcessId') id: string,
    @Body() body: unknown,
  ): Promise<InboundExcessView> {
    const session = await this.authorize(request);
    return this.excesses.link(parseExcessId(id), parseLinkBody(body), session.userId);
  }

  @Post(':inboundReceiptExcessId\\:unlink')
  @HttpCode(HttpStatus.OK)
  async unlink(@Req() request: Request, @Param('inboundReceiptExcessId') id: string): Promise<InboundExcessView> {
    const session = await this.authorize(request);
    return this.excesses.unlink(parseExcessId(id), session.userId);
  }

  private async authorize(request: Request): Promise<Session> {
    const session = await this.resolver.resolve(request);
    if (session === null) throw loginRequired();
    attachSession(request, session);
    assertOperationPermission(session, OPERATION);
    return session;
  }
}
