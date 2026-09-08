import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Contract } from '../../common/contract';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { NonconformanceListQuery, NonconformanceQueryService } from './nonconformance-query.service';
import { NonconformanceView } from './nonconformance-view';

/**
 * `GET /quality/nonconformances` · `…/{nonconformanceId}` — 부적합 목록·상세(I-21 PR ①a·①b).
 * `W-03-10`·`W-04-07`·`W-04-11` 이 함께 쓴다. ⛔ 조회 8건 어디에도 계약이 403 을 선언하지
 * 않았다(`permission.guard.ts:37-41` 실측) ⇒ 권한 등록 0줄. ⛔ 목록은 멱등·If-Match·ETag 0
 * — 계약 미선언.
 *
 * ⭐ 상세만 ETag 를 낸다 — `nonconformance.version_no`(이 행 자신의 값). ⛔ **본문에는 안
 * 싣는다**(공유계약 A-4 · `nonconformance-view.ts` 가 이미 그렇게 만든다) — `setEtag` 로만
 * 나간다. 이 토큰은 «다른 계약 파일»(`quality-03품질.json`)의 처분 판정 저장
 * (`POST …/{id}/disposition-decisions`)이 If-Match 로 받는 원천이다(I-21 §0 판정 #5) — 원천
 * 검사기가 한 파일 안에서만 후보를 찾아 이 자리를 못 본다. 처분·후보·특채·쓰기 오퍼레이션은
 * 각각 다른 PR 몫이다(I-21 §10-1).
 */
@Controller('quality')
export class NonconformanceController {
  constructor(private readonly nonconformances: NonconformanceQueryService) {}

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
}
