import { Body, Controller, Get, HttpStatus, NotFoundException, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionsByNonconformance, dispositionsByNonconformance } from './disposition-by-nonconformance';
import { DispositionFilters, dispositionByIdQuery, dispositionCountQuery, dispositionRowsQuery } from './disposition-query';
import { DispositionDecisionCreate, DispositionWriteService } from './disposition-write.service';
import { DispositionDecisionRow, DispositionDecisionView, assertFollowUpInvariant, dispositionDecisionView } from './disposition-view';

export interface DispositionListQuery extends DispositionFilters {
  page?: number;
  size?: number;
}

/**
 * `GET /quality/disposition-decisions` · `…/{dispositionDecisionId}`(I-21 PR ②a″) ·
 * `…/nonconformances/{nonconformanceId}/disposition-decisions`(+`summary` · PR ②b). `W-03-10`·
 * `W-04-10`·`W-04-11`·`P-04-03`이 함께 쓴다. `disposition-query.ts` 가 후속 롤업 필터를 원시
 * SQL 로 낸다(§2 — `disposition-rollup.ts` 를 페이지네이션 «전»에 못 부른다). `byNonconformance`
 * 는 `disposition-by-nonconformance.ts` 에 위임한다 — 그 파일 머리 주석이 404 판정 근거를 진다.
 * ⛔ ETag·If-Match·403 게이트 0 — 계약 미선언(§1-1 · `permission.guard.ts:37-41`).
 * ⛔ 후보(③) · 특채(⑤) · 쓰기(⑥⑦)는 이 PR 의 몫이 아니다.
 */
@Controller('quality')
export class DispositionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: DispositionWriteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('disposition-decisions')
  @Contract('GET /quality/disposition-decisions')
  async list(@Query() query: DispositionListQuery): Promise<PagedResponse<DispositionDecisionView>> {
    assertDecidedPeriodPair(query);
    const page = pageRequest(query);
    const rowsQuery = dispositionRowsQuery(query, { skip: page.skip, take: page.take });
    const countQuery = dispositionCountQuery(query);
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<DispositionDecisionRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(countQuery.sql, ...countQuery.params),
    ]);
    const rendered = rows.map(dispositionDecisionView);
    assertFollowUpInvariant(query, rendered);

    return {
      items: rendered.map((row) => row.view),
      page: { page: page.page, size: page.size, total: countRows[0]?.total ?? 0 },
    };
  }

  @Get('disposition-decisions/:dispositionDecisionId')
  @Contract('GET /quality/disposition-decisions/{dispositionDecisionId}')
  async get(@Param('dispositionDecisionId', ParseIntPipe) dispositionDecisionId: number): Promise<DispositionDecisionView> {
    const rowsQuery = dispositionByIdQuery(dispositionDecisionId);
    const rows = await this.prisma.$queryRawUnsafe<DispositionDecisionRow[]>(rowsQuery.sql, ...rowsQuery.params);
    if (rows.length === 0) throw new NotFoundException('없는 처분 결정입니다.');
    return dispositionDecisionView(rows[0]).view;
  }

  @Get('nonconformances/:nonconformanceId/disposition-decisions')
  @Contract('GET /quality/nonconformances/{nonconformanceId}/disposition-decisions')
  byNonconformance(@Param('nonconformanceId', ParseIntPipe) nonconformanceId: number): Promise<DispositionsByNonconformance> {
    return dispositionsByNonconformance(this.prisma, nonconformanceId);
  }

  /**
   * ⭐⭐ 처분 판정 저장(I-21 PR ⑦ · 심장 B) — 저장소 **유일한** 「201 + If-Match 필수 + ETag」다.
   * ⛔ **`runVersioned` 를 못 쓴다** — 성공 상태를 `HttpStatus.OK` 로 «고정»하고 전 사용처가 200
   *    PUT 이다. 공용 코어(`master-write.ts`)에 인자를 더하는 길은 세 레인 공용 파일이라 **안
   *    골랐다**(§3-3 통합자 판정) ⇒ 여기서 손으로 엮는다(다음 사람이 다시 재지 않게 남긴다).
   * ⛔ **`@HttpCode` 를 달지 않는다** — `@Post` 기본값이 이미 201 이라 달면 오히려 어긋난다.
   * ⚠ `runIdempotent` 의 셋째 인자는 **HTTP 상태가 아니다** — `master-write.ts:44` 가
   *    `outcome.status` 를 버려 `idempotency_record.response_status` 에만 남는다. HTTP 로는 영영
   *    관측되지 않아 **e2e 가 그 칸을 직접 단언한다**.
   * ⭐ **If-Match 토큰은 «이 경로의 GET» 이 아니라** 부적합 상세(04 제품출하 계약)의 ETag 다 —
   *    잠그는 대상이 결정 한 건이 아니라 **부적합**이라서다. ⛔ 계약이 「토큰 원천 검사기는 한
   *    파일 안에서만 후보를 찾아 이 자리를 못 본다」라 **스스로 경고한 첫 자리**다(§0 판정 #5).
   * ⛔ 계열 봉투라 다섯째 인자를 넘긴다 — 그 상수 이름을 «이 주석에» 적지 않는다:
   *    `family-conflict-code.spec.ts` 는 소스를 `@Contract` 로 끊어 세므로 **앞 마크가 이 주석을
   *    삼켜** 앞 오퍼레이션이 「계열이 아닌데 넘겼다」로 오판된다(리뷰어가 재현 확인).
   * 403 게이트는 `manual-permissions.ts` 의 `W-03-10` 이 연다(도출표엔 없었다 · 통보 181).
   */
  @Post('nonconformances/:nonconformanceId/disposition-decisions')
  @Contract('POST /quality/nonconformances/{nonconformanceId}/disposition-decisions')
  async decide(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('nonconformanceId', ParseIntPipe) nonconformanceId: number,
    @Body() body: DispositionDecisionCreate,
  ): Promise<DispositionDecisionView> {
    // 가드가 이 자리에서 If-Match 를 이미 필수로 막았다 — 여기 오면 값이 있다.
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');

    const result = await runIdempotent(
      this.idempotency,
      request,
      HttpStatus.CREATED,
      () => this.writes.create(nonconformanceId, version, body, session.userId),
      FAMILY_CONFLICT_CODE,
    );
    setEtag(response, result.versionNo);
    return result.view;
  }
}

/**
 * `decidedFrom`·`decidedTo` 는 한 쌍이다(§1-2 갈래 B — 「이력 모드에서 필수」의 판정 축이
 * 계약에 없어 한쪽만 오면 400, 둘 다 없으면 통과). ⚠ 계약이 쌍 검증도 400 자체도 선언하지
 * 않았다 — I-20 §9-3 ⓒ 계열(「알려둘 것」).
 */
function assertDecidedPeriodPair(query: { decidedFrom?: string; decidedTo?: string }): void {
  if ((query.decidedFrom !== undefined) === (query.decidedTo !== undefined)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [field('decidedTo', ERROR_CODE.PAIR, 'decidedFrom·decidedTo 는 함께 보내거나 함께 생략합니다.')]);
}
