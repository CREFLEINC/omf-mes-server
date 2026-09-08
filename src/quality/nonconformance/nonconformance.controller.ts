import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
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
