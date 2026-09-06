import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion } from '../../common/optimistic-lock';
import type { PagedResponse } from '../../common/pagination';
import { ProductionResultApprovalService } from './production-result-approval.service';
import { ProductionResultCorrect, ProductionResultCorrectService } from './production-result-correct.service';
import { ProductionResultListQuery, ProductionResultQueryService } from './production-result-query.service';
import { ProductionResultCreate } from './production-result-rules';
import { ProductionResultService } from './production-result.service';
import { ProductionResultView } from './production-result-view';

/**
 * 생산 실적 조회 — 목록·단건(I-7 PR ①) + 등록(PR ②) + 정정·상신(PR ③). 질의·본문의 형·enum 검증은 계약 검증
 * 가드(`@Contract`)가 이미 한다 — 여기서 다시 검사하지 않는다.
 * ⛔ 권한 가드는 계약이 403 을 «선언한» 자리에서만 본다 — 조회 둘은 미선언이고 등록·정정·상신
 *    셋이 선언돼 있다(`derived-permissions.ts` — 등록은 POP 단말 화면 넷, 정정·상신은 `W-02-05`).
 * ⛔ `setEtag` 를 부르지 않는다 — 계약이 ETag 를 선언한 것이 I-7 7건 중 0건이다.
 */
@Controller('production/production-results')
export class ProductionResultController {
  constructor(
    private readonly queries: ProductionResultQueryService,
    private readonly results: ProductionResultService,
    private readonly corrections: ProductionResultCorrectService,
    private readonly approvals: ProductionResultApprovalService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /production/production-results')
  list(@Query() query: ProductionResultListQuery): Promise<PagedResponse<ProductionResultView>> {
    return this.queries.list(query);
  }

  @Get(':productionResultId')
  @Contract('GET /production/production-results/{productionResultId}')
  detail(@Param('productionResultId', ParseIntPipe) productionResultId: number): Promise<ProductionResultView> {
    return this.queries.detail(productionResultId);
  }

  /**
   * 실적 등록. ⛔ `runVersioned` 를 못 쓴다 — If-Match 가 **선택**이라 토큰이 없으면 저쪽이
   * 던져 500 이 된다(`master-write.ts:48-51` · I-6 §8-3 과 같은 가름). 대신 `undefined` 를
   * 그대로 내려보내 서비스가 대조를 건너뛴다.
   */
  @Post()
  @Contract('POST /production/production-results')
  create(@Req() request: Request, @Body() body: ProductionResultCreate): Promise<ProductionResultView> {
    // ⛔ 헤더는 계약 검증 가드가 안 본다(`contract-validator.ts:206-207`) — 사번의 필수 판정은 서비스 몫이다.
    const workerNo = request.headers['x-worker-no'];
    const context = {
      workerNo: typeof workerNo === 'string' ? workerNo : undefined,
      idempotencyKey: String(request.headers['idempotency-key']),
      version: ifMatchVersion(request),
      appUserId: currentSession(request)?.userId,
    };
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.results.create(body, context));
  }

  /** 정정. 새 «전표»가 서므로 201 이다. ⛔ If-Match·X-Worker-No 를 안 읽는다 — 계약이 둘 다 걷었다(2026-09-04). */
  @Post(':productionResultId\\:correct')
  @Contract('POST /production/production-results/{productionResultId}:correct')
  correct(
    @Req() request: Request,
    @Param('productionResultId', ParseIntPipe) productionResultId: number,
    @Body() body: ProductionResultCorrect,
  ): Promise<ProductionResultView> {
    const context = { idempotencyKey: String(request.headers['idempotency-key']), appUserId: currentSession(request)?.userId };
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.corrections.correct(productionResultId, body, context),
    );
  }

  /** ⭐ 202 다 — 요청을 «접수»할 뿐 결재는 결재함이 한다. 등급·승인 유형은 서버가 낸다. */
  @Post(':productionResultId\\:request-approval')
  @Contract('POST /production/production-results/{productionResultId}:request-approval')
  @HttpCode(HttpStatus.ACCEPTED)
  requestApproval(
    @Req() request: Request,
    @Param('productionResultId', ParseIntPipe) productionResultId: number,
    @Body() body: { reason: string },
  ): Promise<{ approvalRequestId: number }> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
    return runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, () =>
      this.approvals.requestApproval(productionResultId, body.reason, session.userId),
    );
  }
}
