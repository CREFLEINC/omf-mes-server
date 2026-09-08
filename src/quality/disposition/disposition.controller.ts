import { Controller, Get, HttpStatus, NotFoundException, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionFilters, dispositionByIdQuery, dispositionCountQuery, dispositionRowsQuery } from './disposition-query';
import { DispositionDecisionRow, DispositionDecisionView, assertFollowUpInvariant, dispositionDecisionView } from './disposition-view';

export interface DispositionListQuery extends DispositionFilters {
  page?: number;
  size?: number;
}

/**
 * `GET /quality/disposition-decisions` · `…/{dispositionDecisionId}` — 처분 결정 조회(I-21 PR
 * ②a″). `W-03-10`·`W-04-10`·`W-04-11`·`P-04-03`이 함께 쓴다. `disposition-query.ts` 가 후속
 * 롤업 필터를 원시 SQL 로 낸다(§2 — `disposition-rollup.ts` 를 페이지네이션 «전»에 못 부른다).
 * ⛔ ETag·If-Match·403 게이트 0 — 계약 미선언(§1-1 · `permission.guard.ts:37-41`).
 * ⛔ `…/{ncId}/disposition-decisions`(②b) · 후보(③) · 특채(⑤) · 쓰기(⑥⑦)는 이 PR 의 몫이 아니다.
 */
@Controller('quality')
export class DispositionController {
  constructor(private readonly prisma: PrismaService) {}

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
