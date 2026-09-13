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
import { currentTerminal } from '../../auth/terminal-context';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { LotComplete, LotCompleteService } from './lot-complete.service';
import {
  LotExternalIdentifierService,
  LotExternalIdentifierUpsert,
} from './lot-external-identifier.service';
import { LotHoldListService } from './lot-hold-list.service';
import { LotIqcSkipService } from './lot-iqc-skip.service';
import { bool } from './lot-rules';
import { ExternalIdentifierView, HoldView, LotView } from './lot-view';
import { LotCreate, LotQuery, LotService, LotUpdate } from './lot.service';
import { lotWriteActorOf } from './lot-write-actor';

/** LOT. 화면은 `M-01-02`·`P-01-01` 이 만들고 여러 화면이 읽는다. */
@Controller('trace/lots')
export class LotController {
  constructor(
    private readonly lots: LotService,
    private readonly completes: LotCompleteService,
    private readonly idempotency: IdempotencyService,
    private readonly externalIdentifiers: LotExternalIdentifierService,
    private readonly holdList: LotHoldListService,
    private readonly iqcSkips: LotIqcSkipService,
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

  @Get(':lotId/external-identifiers')
  @Contract('GET /trace/lots/{lotId}/external-identifiers')
  listExternalIdentifiers(
    @Param('lotId', ParseIntPipe) lotId: number,
  ): Promise<{ items: ExternalIdentifierView[] }> {
    return this.externalIdentifiers.list(lotId);
  }

  @Get(':lotId/holds')
  @Contract('GET /trace/lots/{lotId}/holds')
  listHolds(
    @Param('lotId', ParseIntPipe) lotId: number,
    @Query('activeOnly') activeOnly: string | boolean | undefined,
  ): Promise<{ items: HoldView[] }> {
    return this.holdList.list(lotId, bool(activeOnly) ?? true);
  }

  @Post()
  @Contract('POST /trace/lots')
  create(@Req() request: Request, @Body() body: LotCreate): Promise<unknown> {
    const actor = lotWriteActorOf(request, 'POST /trace/lots');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.lots.create(body, actor),
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
    const terminal = currentTerminal(request);
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      version: ifMatchVersion(request),
      appUserId: currentSession(request)?.userId,
      ...(terminal === undefined || typeof workerNo !== 'string' ? {} : {
        terminalAudit: {
          workerNo, terminalId: terminal.terminalId,
          plantId: terminal.plantId,
          correlationId: String(request.headers['idempotency-key']),
          operationKey: 'POST /trace/lots/{lotId}:complete',
        },
      }),
    };
    // ⛔ `setEtag` 를 부르지 않는다 — 계약이 `:complete` 200 에 ETag 를 선언하지 않았다(I-7 §1-1 ·
    //    I-6 §8-2 와 같은 가름). `version_no` 는 올라가므로 화면은 완료 뒤 `GET` 으로 새 토큰을 받는다(ⓦ).
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () => this.completes.complete(lotId, body, context));
  }

  /**
   * ⭐ If-Match 는 **부모** `trace.lot.version_no` 다 — 「잠그는 단위가 부모이기 때문이다」(계약 ·
   * B-1-1). ⛔ 응답에 ETag 를 안 내린다(계약이 이 경로에 헤더 미선언) — 화면은 다음 토큰을
   * 상세 GET 으로 받는다.
   */
  @Put(':lotId/external-identifiers')
  @Contract('PUT /trace/lots/{lotId}/external-identifiers')
  replaceExternalIdentifiers(
    @Req() request: Request,
    @Param('lotId', ParseIntPipe) lotId: number,
    @Body() body: { items: LotExternalIdentifierUpsert[] },
  ): Promise<{ items: ExternalIdentifierView[] }> {
    const version = versionOf(request);
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.externalIdentifiers.replace(lotId, version, body.items, appUserId),
    );
  }

  /**
   * ⭐ 202 다 — 요청을 «접수»할 뿐 결재는 결재함이 한다. 승인 유형·대상은 서버가 낸다(본문 미수신).
   * ⛔ If-Match 를 안 읽는다(계약에 없다) · ⛔ `setEtag` 를 안 부른다.
   */
  @Post(':lotId\\:request-iqc-skip')
  @Contract('POST /trace/lots/{lotId}:request-iqc-skip')
  @HttpCode(HttpStatus.ACCEPTED)
  requestIqcSkip(
    @Req() request: Request,
    @Param('lotId', ParseIntPipe) lotId: number,
    @Body() body: { reason: string },
  ): Promise<{ approvalRequestId: number }> {
    // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:96`) — 사번의 필수 판정은 서비스 몫이다.
    const workerNo = request.headers['x-worker-no'];
    const actor = lotWriteActorOf(request, 'POST /trace/lots/{lotId}:request-iqc-skip');
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      ...actor,
    };
    return runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, () =>
      this.iqcSkips.requestSkip(lotId, body.reason, context),
    );
  }
}

/**
 * ⛔ 치환은 `runVersioned` 를 못 쓴다 — 응답에 ETag 가 없어 새 토큰을 내릴 자리가 없다.
 * 대신 가드가 파싱해 둔 If-Match 값을 꺼내 서비스가 «비교만» 한다(출고 라인 치환 선례).
 */
function versionOf(request: Request): number {
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }
  return version;
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
