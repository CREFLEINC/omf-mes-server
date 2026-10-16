import { Body, Controller, Get, HttpStatus, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { PagedResponse } from '../../common/pagination';
import { DefectDistributionQuery, DefectDistributionService } from './defect-distribution.service';
import { DefectRecordListQuery, DefectRecordService } from './defect-record.service';
import { DefectRecordCreate, DefectRecordWriteService } from './defect-record-write.service';
import { DefectRecordView } from './defect-view';

/**
 * 불량 실적 조회 2건(I-20 PR ①b) + 등록 1건(omf-all-around#106 · 서버 선행 P-39 — 계약은 등록 경로를
 * 두지 않았다). 등록은 관리웹 계정의 조작이다 — 단말 경로(#108 POP)는 그 이슈가 범위를 연다.
 * ⛔ 조회 2건은 계약이 403 을 선언하지 않았다(`permission.guard.ts:37-41`) — 권한 등록 0줄.
 * ⛔ 멱등·If-Match·ETag 0 — 계약 미선언.
 */
@Controller('quality/defect-records')
export class DefectRecordController {
  constructor(
    private readonly records: DefectRecordService,
    private readonly distributions: DefectDistributionService,
    private readonly writes: DefectRecordWriteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Contract('POST /quality/defect-records')
  create(@Req() request: Request, @Body() body: DefectRecordCreate): Promise<DefectRecordView> {
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.writes.create(body, session.userId));
  }

  @Get()
  @Contract('GET /quality/defect-records')
  list(@Req() request: Request, @Query() query: DefectRecordListQuery): Promise<PagedResponse<DefectRecordView>> {
    return this.records.list(query, currentTerminalQualityReadScope(request));
  }

  @Get('distribution')
  @Contract('GET /quality/defect-records/distribution')
  distribution(@Query() query: DefectDistributionQuery) {
    return this.distributions.distribution(query);
  }
}
