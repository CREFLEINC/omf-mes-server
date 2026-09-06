import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { LotLifecycleEventQuery, LotLifecycleEventService } from './lot-lifecycle-event.service';
import { LotLifecycleEventView } from './lot-lifecycle-event-view';

/**
 * LOT 생명주기 변경이력 — 경로가 `trace/lots` 와 달라 `LotController` 에 얹지 않는다.
 * 오퍼레이션 하나에 디렉터리를 새로 만들지도 않는다(R-13 · I-18 이 같은 축을 더한다).
 * ⛔ 403·ETag·멱등 없음.
 */
@Controller('trace/lot-lifecycle-events')
export class LotLifecycleEventController {
  constructor(private readonly events: LotLifecycleEventService) {}

  @Get()
  @Contract('GET /trace/lot-lifecycle-events')
  list(@Query() query: LotLifecycleEventQuery): Promise<{ items: LotLifecycleEventView[] }> {
    return this.events.list(query);
  }
}
