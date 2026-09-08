import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { LotStatusEventQuery, LotStatusEventService } from './lot-status-event.service';
import { LotStatusEventView } from './lot-status-event-view';

/**
 * LOT 상태 변경이력 — 경로가 `trace/lots` 와 달라 `LotController` 에 얹지 않는다
 * (형제 `lot-lifecycle-event.controller.ts:5-6` 이 이 슬라이스를 예고해 두었다 · R-13).
 * ⛔ 403·ETag·멱등 없음 — 계약이 200 하나만 선언한다.
 */
@Controller('trace/lot-status-events')
export class LotStatusEventController {
  constructor(private readonly events: LotStatusEventService) {}

  @Get()
  @Contract('GET /trace/lot-status-events')
  list(@Query() query: LotStatusEventQuery): Promise<{ items: LotStatusEventView[] }> {
    return this.events.list(query);
  }
}
