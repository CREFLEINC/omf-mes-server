import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LotHoldEventFilters,
  LotHoldEventRow,
  LotHoldEventSort,
  LotHoldEventView,
  lotHoldEventCountQuery,
  lotHoldEventRowsQuery,
  lotHoldEventView,
} from './lot-hold-event-query';
import { LotHoldListQuery, LotHoldQueryService } from './lot-hold-query.service';
import { LotHoldCreate } from './lot-hold-rules';
import { LotHoldView } from './lot-hold-view';
import { LotHoldWriteService } from './lot-hold-write.service';

/** `GET /quality/lot-hold-events` 질의 11칸 — `occurredFrom`/`occurredTo` 는 계약 `required:true`(가드가 400 REQUIRED 를 이미 낸다 · 중복 구현 0). */
export interface LotHoldEventListQuery extends LotHoldEventFilters {
  sort?: LotHoldEventSort;
  page?: number;
  size?: number;
}

const DEFAULT_EVENT_SORT: LotHoldEventSort = 'occurredDesc';

/**
 * `GET /quality/lot-holds` · `GET /quality/lot-holds/{lotHoldId}` — LOT 보류 목록·상세.
 * `W-03-01`(이력으로 찾기)·`W-03-02`(대상 목록·드로어)가 함께 쓴다. ⛔ 403 게이트 —
 * 계약이 조회 8건 어디에도 403 을 안 선언했다(`permission.guard.ts:37-41`) ⇒ 등록 0줄.
 *
 * ⭐⭐ **상세의 ETag — 계약 실측이 구현 브리프의 판정을 뒤집는다.** 브리프는 「ETag =
 * `lot_hold.version_no`」로 못 박았지만, 계약 원문은 정확히 반대다. 원문 인용 둘:
 *  ⓐ 상세 200 ETag 헤더 설명(`contracts/quality-03품질.json:1950`) — 「낙관적 잠금 토큰 —
 *    ⭐ 이 보류 «행»의 것이 아니라 이 보류가 걸린 «LOT» 의 판 번호(`trace.lot.version_no`)다.
 *    잠그는 대상이 LOT 이기 때문이다 — 보류 해제는 LOT 의 품질 상태를 옮기는 일이고, 보류
 *    행 자체는 기록 전용이라 판 번호를 갖지 않는다 … ⚠ 이 설명은 2026-08-24 에 정정됐다
 *    (omf-mes#190 질문4) — 표준 문구를 베끼면서 「이 행의 version_no」로 적혀 있었고, 그것은
 *    없는 컬럼을 가리켰다」.
 *  ⓑ `:release` 의 `x-internal-note`(`:2058`) — 「If-Match 는 `lot_hold` 가 아니라
 *    `trace.lot` 의 version_no 다 — `lot_hold` 에는 version_no 가 없다(기록 전용)」.
 * ⇒ `lot_hold.version_no`(M-f 가 더한 칸)는 **이 ETag 의 원천이 아니다** — 읽지 않는다.
 *   `LotHoldQueryService.get()` 이 돌려주는 `lotVersionNo` 는 `row.lot.version_no` 다.
 *   PR 본문에 이 정정을 「알려둘 것」으로 남긴다 — 이후 `:release`(PR ⑤)의 If-Match 검증도
 *   같은 값(`trace.lot.version_no`)을 대조해야 한다.
 */
@Controller('quality')
export class LotHoldController {
  constructor(
    private readonly lotHolds: LotHoldQueryService,
    private readonly writes: LotHoldWriteService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('lot-holds')
  @Contract('GET /quality/lot-holds')
  list(@Query() query: LotHoldListQuery): Promise<PagedResponse<LotHoldView>> {
    assertHeldPair(query);
    return this.lotHolds.list(query);
  }

  @Get('lot-holds/:lotHoldId')
  @Contract('GET /quality/lot-holds/{lotHoldId}')
  async get(
    @Param('lotHoldId', ParseIntPipe) lotHoldId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LotHoldView> {
    const { view, lotVersionNo } = await this.lotHolds.get(lotHoldId);
    setEtag(response, lotVersionNo);
    return view;
  }

  /**
   * ⭐ LOT 보류 등록(PR ④ · 심장 A). `lot_hold` INSERT · `lot.status_code` 이동 ·
   * `lot_status_event` 가 한 트랜잭션이다(B-8) — 갈래와 순서는 서비스가 진다.
   *
   * ⛔ `runVersioned` 가 아니라 `runIdempotent` 다 — 이 등록만 헤더 `If-Match` 를 «안 쓴다»
   *    (계약 `:4091` — 여러 LOT 이라 토큰이 여럿이다). 토큰은 본문 `lots[].versionNo` 로 온다.
   * ⛔ ETag 를 안 낸다 — 계약이 201 에 선언하지 않았고 응답이 «배열»이라 실을 행이 없다.
   * ⛔ `X-Worker-No` 를 안 읽는다 — `lot_status_event.changed_by` 가 NOT NULL 이라 계정
   *    세션이 유일한 원천이다(0단계 선례 `inspection-result.controller.ts`).
   * 403 게이트는 `derived-permissions.ts:252` 에 이미 있다 — `manual-permissions.ts` 0줄.
   */
  @Post('lot-holds')
  @Contract('POST /quality/lot-holds')
  create(@Req() request: Request, @Body() body: LotHoldCreate): Promise<LotHoldView[]> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.writes.create(body, appUserId));
  }

  /**
   * `GET /quality/lot-hold-events` — 한 `lot_hold` 행을 최대 두 사건으로 편다(§4-3).
   * `lot-hold-event-query.ts` 가 `SELECT … UNION ALL SELECT …` 한 문장을 짓는다(0단계 선례
   * `lot-status.controller.ts` — `$queryRawUnsafe` 로 직접 부르고 별도 서비스를 두지 않는다).
   */
  @Get('lot-hold-events')
  @Contract('GET /quality/lot-hold-events')
  async events(@Query() query: LotHoldEventListQuery): Promise<PagedResponse<LotHoldEventView>> {
    const sort = query.sort ?? DEFAULT_EVENT_SORT;
    const page = pageRequest(query);
    const rowsQuery = lotHoldEventRowsQuery(query, sort, { skip: page.skip, take: page.take });
    const countQuery = lotHoldEventCountQuery(query);
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<LotHoldEventRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(countQuery.sql, ...countQuery.params),
    ]);
    return {
      items: rows.map(lotHoldEventView),
      page: { page: page.page, size: page.size, total: countRows[0]?.total ?? 0 },
    };
  }
}

/**
 * `heldFrom`·`heldTo` 는 한 쌍이다(§1-2 갈래 B — 「함께 보내거나 함께 생략한다」).
 * ⚠ 계약이 이 쌍 검증도 400 자체도 선언하지 않았다 — I-4 R-9 ⓒ·I-20 §9-3 ⓒ 와 같은 자리
 * (「알려둘 것」 — `GET /quality/lot-holds` 도 그 목록에 있다).
 */
function assertHeldPair(query: { heldFrom?: string; heldTo?: string }): void {
  if ((query.heldFrom !== undefined) === (query.heldTo !== undefined)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('heldTo', ERROR_CODE.PAIR, 'heldFrom·heldTo 는 함께 보내거나 함께 생략합니다.'),
  ]);
}

/** `lot_status_event.changed_by` 가 NOT NULL 이라 보류 등록에는 계정 세션이 반드시 있어야 한다. */
function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
