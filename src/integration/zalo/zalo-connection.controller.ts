import { Body, Controller, Get, HttpStatus, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { ZaloConnectionReplace, ZaloConnectionService, ZaloConnectionView } from './zalo-connection.service';

/** Zalo 연결 설정(W-CO-12 · 장부 P-95). 비밀값은 응답에 «설정됨» 여부로만 보인다. */
@Controller('app/zalo-connection')
export class ZaloConnectionController {
  constructor(
    private readonly connections: ZaloConnectionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/zalo-connection')
  async get(@Res({ passthrough: true }) response: Response): Promise<ZaloConnectionView> {
    const { connection, versionNo } = await this.connections.get();
    // 비밀값이 아니어도 연결 상태 응답은 브라우저에 남기지 않는다.
    response.setHeader('Cache-Control', 'private, no-store');
    setEtag(response, versionNo);
    return connection;
  }

  @Put()
  @Contract('PUT /app/zalo-connection')
  async replace(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: ZaloConnectionReplace,
  ): Promise<ZaloConnectionView> {
    const version = ifMatchVersion(request);
    if (version === undefined) throw new Error('If-Match 가 없는데 계약 가드를 지났다');
    // 멱등 기록에는 본문의 해시와 «응답»만 남는다 — 응답에 비밀값이 없으니 원문이 저장되지 않는다.
    const { connection, versionNo } = await runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) =>
      this.connections.replaceWithin(tx, version, body, currentSession(request)?.userId),
    );
    response.setHeader('Cache-Control', 'private, no-store');
    setEtag(response, versionNo);
    return connection;
  }
}
