import { Controller, Get, HttpStatus, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { LotStatusSort, lotStatusCountQuery, lotStatusRowsQuery } from './lot-status-query';
import { LotStatusRow, LotStatusView, lotStatusView } from './lot-status-view';

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
 * `GET /quality/lot-statuses` — LOT 품질 상태 목록. `W-03-01`·`W-03-02`·`W-03-03` 이 함께 쓴다
 * (§4-1). 창고·수량·보류 요약·최근 전이는 `lot-status-query.ts` 가 원시 SQL 로 접는다.
 *
 * ⛔ **이 컨트롤러는 이 오퍼레이션 하나만 연다** — `lot-status-summary`(PR ①a2)·
 * `lot-status-transitions`(PR ①c) 는 자리를 만들지 않는다(README §1-2 · CLAUDE.md 「사용처
 * 하나뿐인 선제적 레이어 금지」 — 셋을 미리 얹으면 이 PR 이 안 만든 오퍼레이션의 골격만 남는다).
 * ⛔ 403 게이트는 `derived-permissions.ts` 에 이미 있다 — `manual-permissions.ts` 0줄.
 */
@Controller('quality/lot-statuses')
export class LotStatusController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
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
}

/**
 * `transitionFrom`·`transitionTo` 는 한 쌍이다(계약 설명 — 「함께 보내거나 함께 생략한다」).
 * ⚠ 계약이 이 쌍 검증도 400 자체도 선언하지 않았다 — I-4 R-9 ⓒ·§9-3 ⓒ 와 같은 자리(「알려둘 것」).
 */
function assertTransitionPair(query: LotStatusListQuery): void {
  if ((query.transitionFrom !== undefined) === (query.transitionTo !== undefined)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('transitionTo', ERROR_CODE.PAIR, 'transitionFrom·transitionTo 는 함께 보내거나 함께 생략합니다.'),
  ]);
}
