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
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { LotComplete, LotCompleteService } from './lot-complete.service';
import { bool } from './lot-rules';
import { LotView } from './lot-view';
import { LotCreate, LotQuery, LotService, LotUpdate } from './lot.service';

/** LOT. 화면은 `M-01-02`·`P-01-01` 이 만들고 여러 화면이 읽는다. */
@Controller('trace/lots')
export class LotController {
  constructor(
    private readonly lots: LotService,
    private readonly completes: LotCompleteService,
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
    @Query('withProgress') withProgress: string | boolean | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { detail, versionNo } = await this.lots.get(lotId, bool(withProgress) === true);
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

  /**
   * 생산 LOT 완료. ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**이라 토큰이 없으면 저쪽이
   * 던져 500 이 된다(`master-write.ts:48-51` · 형제 `POST /production/production-results` 와 같은 가름).
   */
  @Post(':lotId\\:complete')
  @Contract('POST /trace/lots/{lotId}:complete')
  // 계약 응답이 200 이다 — Nest 의 `@Post` 기본값 201 을 되돌린다.
  @HttpCode(HttpStatus.OK)
  async complete(
    @Req() request: Request,
    @Param('lotId', ParseIntPipe) lotId: number,
    @Body() body: LotComplete,
  ): Promise<LotView> {
    // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206-207`) — 사번의 필수 판정은 서비스 몫이다.
    const workerNo = request.headers['x-worker-no'];
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      version: ifMatchVersion(request),
      appUserId: currentSession(request)?.userId,
    };
    // ⛔ `setEtag` 를 부르지 않는다 — 계약이 `:complete` 200 에 ETag 를 선언하지 않았다(I-7 §1-1 ·
    //    I-6 §8-2 와 같은 가름). `version_no` 는 올라가므로 화면은 완료 뒤 `GET` 으로 새 토큰을 받는다(ⓦ).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.completes.complete(lotId, body, context));
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
