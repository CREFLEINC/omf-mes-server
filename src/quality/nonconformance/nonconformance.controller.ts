import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE, IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionRequest, NonconformanceCreate } from './nonconformance-rules';
import { NonconformanceWriteService } from './nonconformance-write.service';
import {
  DispositionCandidateFilters,
  DispositionCandidateRow,
  DispositionCandidateView,
  dispositionCandidateCountQuery,
  dispositionCandidateRowsQuery,
  dispositionCandidateView,
} from './disposition-candidate-query';
import { NonconformanceListQuery, NonconformanceQueryService } from './nonconformance-query.service';
import { NonconformanceView } from './nonconformance-view';

export interface DispositionCandidateListQuery extends DispositionCandidateFilters {
  page?: number;
  size?: number;
}

/**
 * `GET /quality/nonconformances` · `…/{nonconformanceId}` · `…/disposition-candidates` —
 * 부적합 목록·상세(I-21 PR ①a·①b) + 처분 판정 대상 목록(PR ③). ⛔ 조회 8건 어디에도 계약이
 * 403 을 선언하지 않았다 ⇒ 권한 등록 0줄. ⛔ 목록·후보는 멱등·If-Match·ETag 0 — 계약 미선언.
 * 상세만 ETag(`nonconformance.version_no`)를 낸다 — «다른 계약 파일»(처분 판정 저장)의 If-Match
 * 원천이다(§0 판정 #5). ⚠ `disposition-candidates` 가 «이» 컨트롤러다(§7-2) —
 * `disposition-decisions/:id` 를 갖는 `DispositionController` 와 세그먼트가 달라 순서 함정이 없다.
 */
@Controller('quality')
export class NonconformanceController {
  constructor(
    private readonly nonconformances: NonconformanceQueryService,
    private readonly writes: NonconformanceWriteService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('nonconformances')
  @Contract('GET /quality/nonconformances')
  list(@Query() query: NonconformanceListQuery): Promise<PagedResponse<NonconformanceView>> {
    return this.nonconformances.list(query);
  }

  @Get('nonconformances/:nonconformanceId')
  @Contract('GET /quality/nonconformances/{nonconformanceId}')
  async get(
    @Param('nonconformanceId', ParseIntPipe) nonconformanceId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<NonconformanceView> {
    const { view, versionNo } = await this.nonconformances.get(nonconformanceId);
    setEtag(response, versionNo);
    return view;
  }

  /**
   * ⭐ 부적합 등록(PR ⑥ · 심장 A) — 헤더 한 행 + `nonconformance_lot` N행이 한 트랜잭션이다(B-8).
   * ⛔ `runVersioned` 가 아니라 `runIdempotent` 다 — 계약이 등록에 `If-Match` 를 «선언하지 않았다»
   *    (§1-1 · 새로 만드는 자원이라 대조할 판이 없다). ETag 도 안 낸다(201 에 미선언).
   * ⭐ 계열 봉투의 `code` 를 다섯째 인자로 넘긴다 — 409 가 `ShipmentConflictResponse`(`code`
   *    required)라 멱등 재생 409 도 그 칸을 실어야 한다(통보 077 · `family-conflict-code.spec.ts`
   *    가 계약 × 컨트롤러를 기계로 대조한다). ⛔ 그 상수 이름을 «이 주석에» 적지 않는다 —
   *    그 스펙이 소스를 `@Contract` 로 끊어 세므로, 마크 «앞»의 주석은 앞 오퍼레이션 몫이 된다.
   * 403 게이트는 `derived-permissions.ts:254`(`W-04-07`)에 이미 있다 — `manual-permissions.ts` 0줄.
   */
  @Post('nonconformances')
  @Contract('POST /quality/nonconformances')
  create(@Req() request: Request, @Body() body: NonconformanceCreate): Promise<NonconformanceView> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.writes.create(body, appUserId), FAMILY_CONFLICT_CODE);
  }

  /**
   * ⭐ 처분 판정 의뢰(PR ⑥ · 심장 B) — `status_code`(`NOT_REQUESTED` → `PENDING_DECISION`)와
   * `version_no` **둘만** 바꾼다. 본문 3칸은 담을 데가 0이라 형식만 보고 버린다(§1-3).
   * ⭐⭐ **If-Match 토큰은 `quality.nonconformance.version_no` 이고, 그 ETag 를 내는 것은 위
   *    `GET …/{nonconformanceId}` 다**(§0 판정 #5). ⛔ 계약이 「토큰 원천 검사기가 한 파일
   *    안에서만 후보를 찾아 이 자리를 못 본다」라 스스로 경고한 첫 자리다 — 판정 저장(PR ⑦)은
   *    «다른 계약 파일»(03 품질)에 있으면서 **같은 값**을 쓴다.
   * ⭐ 토큰 «비교»는 `runVersioned` 가 아니라 서비스의 **조건부 UPDATE + `assertUpdated()`** 가
   *    트랜잭션 끝에서 한다(§3-4 9) — 여기서는 헤더를 파싱해 넘길 뿐이다.
   * ⛔ 200 이라 `@HttpCode` 가 필요하다(`@Post` 기본이 201 이다).
   * 403 게이트는 `derived-permissions.ts:256`(`W-04-07`)에 이미 있다.
   */
  @Post('nonconformances/:nonconformanceId\\:request-disposition')
  @Contract('POST /quality/nonconformances/{nonconformanceId}:request-disposition')
  @HttpCode(HttpStatus.OK)
  requestDisposition(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('nonconformanceId', ParseIntPipe) nonconformanceId: number,
    @Body() body: DispositionRequest,
  ): Promise<NonconformanceView> {
    const appUserId = userOf(request);
    return runVersioned<NonconformanceView, 'view'>(this.idempotency, request, response, 'view', (version) =>
      this.writes.requestDisposition(nonconformanceId, version, body, appUserId), FAMILY_CONFLICT_CODE);
  }

  /** 원시 SQL(`disposition-candidate-query.ts`) — 다른 도메인 service 호출 0(§7-3). */
  @Get('disposition-candidates')
  @Contract('GET /quality/disposition-candidates')
  async dispositionCandidates(@Query() query: DispositionCandidateListQuery): Promise<PagedResponse<DispositionCandidateView>> {
    const page = pageRequest(query);
    const rowsQuery = dispositionCandidateRowsQuery(query, { skip: page.skip, take: page.take });
    const countQuery = dispositionCandidateCountQuery(query);
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<DispositionCandidateRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(countQuery.sql, ...countQuery.params),
    ]);

    return {
      items: rows.map(dispositionCandidateView),
      page: { page: page.page, size: page.size, total: countRows[0]?.total ?? 0 },
    };
  }
}

/** `nonconformance.created_by`·`updated_by` 를 채울 주체 — 쓰기 둘 다 계정 세션이 필요하다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
