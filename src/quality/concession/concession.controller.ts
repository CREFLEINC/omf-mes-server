import {
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
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
import { PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ConcessionFilters, concessionByIdQuery, concessionCountQuery, concessionRowsQuery, todayUtc } from './concession-query';
import { ConcessionRow, ConcessionView, assertUsableInvariant, concessionView } from './concession-view';
import { ConcessionBatch, ConcessionCreate, ConcessionWriteService } from './concession-write.service';

export interface ConcessionListQuery extends ConcessionFilters {
  page?: number;
  size?: number;
}

/**
 * `GET /quality/concessions` · `…/{concessionId}`(I-21 PR ⑤ — 맨 뒤로 미뤄 낸다 · uiux 수정
 * 2). `W-03-09` ②「조건」 구획이 부른다. ⛔ **이 표는 writer 가 0개다** — 계약이 생성·승인·
 * 수정 경로를 두지 않아(§2-4 · 통보 089 §2) 운영에서 목록이 늘 빈다. ⛔ 멱등·If-Match·ETag·
 * 403 게이트 0 — 계약 미선언(§1-1 · `permission.guard.ts:37-41`). `concession-query.ts` 가
 * `usable` 을 원시 SQL 로 다시 걸러 페이지네이션 «전» 필터한다(§4-3 — 다른 도메인 service
 * 호출 0 · §7-3).
 */
@Controller('quality')
export class ConcessionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: ConcessionWriteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * 특채 저장(omf-all-around#84 · 장부 P-79) — 결재 없이 바로 적용한다(omf-all-around#352). LOT 이 여럿인 부적합은 LOT 마다 행이 서고
   * 응답은 첫 행 + 묶음 id(`concessionIds`)다(피처 005 D-14).
   */
  @Post('concessions')
  @Contract('POST /quality/concessions')
  create(@Req() request: Request, @Body() body: ConcessionCreate): Promise<ConcessionView & ConcessionBatch> {
    const appUserId = userOf(request);
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, async () => {
      const batch = await this.writes.request(body, appUserId);
      return { ...(await this.get(batch.concessionIds[0])), ...batch };
    });
  }

  @Get('concessions')
  @Contract('GET /quality/concessions')
  async list(@Query() query: ConcessionListQuery): Promise<PagedResponse<ConcessionView>> {
    const page = pageRequest(query);
    const onDate = query.validOn ?? todayUtc();
    const rowsQuery = concessionRowsQuery(query, onDate, { skip: page.skip, take: page.take });
    const countQuery = concessionCountQuery(query, onDate);
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<ConcessionRow[]>(rowsQuery.sql, ...rowsQuery.params),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(countQuery.sql, ...countQuery.params),
    ]);
    const items = rows.map((row) => concessionView(row, onDate));
    assertUsableInvariant(query.usableOnly, items);

    return {
      items,
      page: { page: page.page, size: page.size, total: countRows[0]?.total ?? 0 },
    };
  }

  @Get('concessions/:concessionId')
  @Contract('GET /quality/concessions/{concessionId}')
  async get(@Param('concessionId', ParseIntPipe) concessionId: number): Promise<ConcessionView> {
    const rowsQuery = concessionByIdQuery(concessionId);
    const rows = await this.prisma.$queryRawUnsafe<ConcessionRow[]>(rowsQuery.sql, ...rowsQuery.params);
    if (rows.length === 0) throw new NotFoundException('없는 특채입니다.');
    return concessionView(rows[0], todayUtc());
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return session.userId;
}
