import { Controller, Get, Query } from "@nestjs/common";

import { Contract } from "../common/contract";
import { PagedResponse } from "../common/pagination";
import {
  AuditEventQuery,
  AuditEventQueryService,
} from "./audit-event-query.service";
import { AuditEventView } from "./audit-event-view";

/** 전 마스터가 공유하는 횡단 변경 이력 조회(B-5). */
@Controller("audit/events")
export class AuditEventController {
  constructor(private readonly events: AuditEventQueryService) {}

  @Get()
  @Contract("GET /audit/events")
  list(
    @Query() query: AuditEventQuery,
  ): Promise<PagedResponse<AuditEventView>> {
    return this.events.list(query);
  }
}
