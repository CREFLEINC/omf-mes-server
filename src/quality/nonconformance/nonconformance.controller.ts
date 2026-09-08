import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { NonconformanceListQuery, NonconformanceQueryService } from './nonconformance-query.service';
import { NonconformanceView } from './nonconformance-view';

/**
 * `GET /quality/nonconformances` — 부적합 목록(I-21 PR ①a). `W-03-10`·`W-04-07`·`W-04-11`
 * 이 함께 쓴다. ⛔ 조회 8건 어디에도 계약이 403 을 선언하지 않았다(`permission.guard.ts:37-41`
 * 실측) ⇒ 권한 등록 0줄. ⛔ 멱등·If-Match·ETag 0 — 계약 미선언.
 *
 * ⭐ 상세(`GET …/{nonconformanceId}`)는 이 PR 의 몫이 아니다(①b) — 같은 컨트롤러에 그 경로가
 * 아직 없어 순서 함정도 없다. 처분·후보·특채·쓰기 오퍼레이션도 각각 다른 PR 몫이다(I-21 §10-1).
 */
@Controller('quality')
export class NonconformanceController {
  constructor(private readonly nonconformances: NonconformanceQueryService) {}

  @Get('nonconformances')
  @Contract('GET /quality/nonconformances')
  list(@Query() query: NonconformanceListQuery): Promise<PagedResponse<NonconformanceView>> {
    return this.nonconformances.list(query);
  }
}
