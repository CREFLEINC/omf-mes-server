import { Controller, Get, HttpStatus, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { LotStatusFilters, LotStatusSort, lotStatusCountQuery, lotStatusRowsQuery } from './lot-status-query';
import { LotStatusTransitionService, LotStatusTransitionSetView } from './lot-status-transition.service';
import { LotStatusRow, LotStatusView, lotStatusView } from './lot-status-view';
import { LotStatusService, LotStatusSummaryView } from './lot-status.service';

export interface LotStatusListQuery {
  lotStatusCode?: string;
  lotTypeCode?: string;
  itemId?: number;
  warehouseId?: number;
  locationId?: number;
  heldOnly?: boolean;
  excludeFullyHeld?: boolean;
  transitionFrom?: string;
  transitionTo?: string;
  q?: string;
  page?: number;
  size?: number;
  plantId?: number;
  sort?: string;
}

/** 계약 기본값(`sort` enum 설명) — `sort` 자체의 값 검증은 계약 가드(ajv enum)가 이미 한다. */
const DEFAULT_SORT: LotStatusSort = 'latestTransitionDesc';

/**
 * `GET /quality/lot-statuses` · `GET /quality/lot-status-summary` — LOT 품질 상태 목록·요약.
 * `W-03-01`·`W-03-02`·`W-03-03` 이 함께 쓴다(§4-1). 창고·수량·보류 요약·최근 전이는
 * `lot-status-query.ts` 가 원시 SQL 로 접는다.
 *
 * ⭐ **경로 접두어를 컨트롤러가 아니라 메서드에 둔다** — `lot-statuses`·`lot-status-summary`·
 * `lot-status-transitions` 는 같은 접두어를 공유하지 않는 «다른» 최상위 리소스라
 * `@Controller('quality')` 아래 리터럴 경로 셋으로 연다(형제 리터럴이 없어 순서 함정도 없다 · §7-2).
 * ⛔ 403 게이트는 `derived-permissions.ts` 에 이미 있다 — `manual-permissions.ts` 0줄.
 */
@Controller('quality')
export class LotStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lotStatusService: LotStatusService,
    private readonly lotStatusTransitionService: LotStatusTransitionService,
  ) {}

  @Get('lot-statuses')
  @Contract('GET /quality/lot-statuses')
  async list(@Query() query: LotStatusListQuery): Promise<PagedResponse<LotStatusView>> {
    assertTransitionPair(query);
    const sort = (query.sort as LotStatusSort | undefined) ?? DEFAULT_SORT;
    const page = pageRequest(query);

    // ⛔ 별도 매핑 함수를 두지 않는다 — `LotStatusListQuery` 가 `LotStatusFilters` 의 상위집합이라
    //   query 를 그대로 넘겨도 구조가 맞는다(page·size·sort 는 필터 빌더가 안 읽는다).
    const rowsQuery = lotStatusRowsQuery(query, sort, { skip: page.skip, take: page.take });
    const countQuery = lotStatusCountQuery(query);
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<LotStatusRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(countQuery.sql, ...countQuery.params),
    ]);

    return {
      items: rows.map(lotStatusView),
      page: { page: page.page, size: page.size, total: countRows[0]?.total ?? 0 },
    };
  }

  /**
   * `GET /quality/lot-status-summary` — ⭐ **§4-1 필터 빌더 공유**. 질의 칸은 목록 14 에서
   * `page`·`size`·`sort` 를 뺀 것과 정확히 같다 — `LotStatusFilters` 를 그대로 질의 타입으로
   * 쓴다(별도 DTO 를 두지 않는다). `LotStatusService` 가 `lot-status-query.ts` 의 WHERE 빌더를
   * 그대로 불러 카드와 목록이 같은 모집단을 센다(#175 — 갈라 두면 서로 다른 것을 센다).
   */
  @Get('lot-status-summary')
  @Contract('GET /quality/lot-status-summary')
  async summary(@Query() query: LotStatusFilters): Promise<LotStatusSummaryView> {
    assertTransitionPair(query);
    return this.lotStatusService.summary(query);
  }

  /**
   * `GET /quality/lot-status-transitions` — 「갈 수 있는 LOT 상태」(I-20 PR ①c). `lotId` 는
   * 계약 `required:true` — 없으면 계약 가드(ajv)가 400 `REQUIRED` 를 먼저 낸다(중복 구현 0).
   * 없는 LOT 은 이 오퍼레이션만 404 를 선언했다(§1-1 실측).
   */
  @Get('lot-status-transitions')
  @Contract('GET /quality/lot-status-transitions')
  async transitions(@Query('lotId') lotId: number): Promise<LotStatusTransitionSetView> {
    return this.lotStatusTransitionService.getTransitions(lotId);
  }
}

/**
 * `transitionFrom`·`transitionTo` 는 한 쌍이다(계약 설명 — 「함께 보내거나 함께 생략한다」).
 * ⚠ 계약이 이 쌍 검증도 400 자체도 선언하지 않았다 — I-4 R-9 ⓒ·§9-3 ⓒ 와 같은 자리(「알려둘 것」).
 * 목록·요약 «둘 다» 쓴다 — 같은 질의라 검증도 하나다(§4-1).
 */
function assertTransitionPair(query: { transitionFrom?: string; transitionTo?: string }): void {
  if ((query.transitionFrom !== undefined) === (query.transitionTo !== undefined)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('transitionTo', ERROR_CODE.PAIR, 'transitionFrom·transitionTo 는 함께 보내거나 함께 생략합니다.'),
  ]);
}
