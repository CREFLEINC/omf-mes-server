import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import {
  PagedResponse,
  pageRequest,
  pagedResponse,
} from "../common/pagination";
import { PrismaService } from "../prisma/prisma.service";
import { AuditEventView, auditEventView } from "./audit-event-view";

export type AuditTargetType =
  | "APP_USER"
  | "ROLE"
  | "WORKER"
  | "TERMINAL"
  | "ITEM"
  | "ROUTING"
  | "INSPECTION_PLAN_VERSION";

/** 계약 질의 9칸. 기간 둘은 `@Contract` 가드가 필수·date-time을 검사한다. */
export interface AuditEventQuery {
  occurredFrom: string;
  occurredTo: string;
  targetTypeCode?: AuditTargetType;
  targetId?: number;
  eventTypeCode?: string;
  performedBy?: number;
  correlationId?: string;
  page?: number;
  size?: number;
}

/** 파티션 키를 먼저, 선택 필터를 뒤에 건다. 기간은 공통 L-3 반개구간이다. */
export function buildAuditEventWhere(
  query: AuditEventQuery,
): Prisma.audit_eventWhereInput {
  return {
    occurred_at: {
      gte: new Date(query.occurredFrom),
      lt: new Date(query.occurredTo),
    },
    ...(query.targetTypeCode === undefined
      ? {}
      : { target_type_code: query.targetTypeCode }),
    ...(query.targetId === undefined
      ? {}
      : { target_id: BigInt(query.targetId) }),
    ...(query.eventTypeCode === undefined
      ? {}
      : { event_type_code: query.eventTypeCode }),
    ...(query.performedBy === undefined
      ? {}
      : { performed_by: BigInt(query.performedBy) }),
    ...(query.correlationId === undefined
      ? {}
      : { correlation_id: query.correlationId }),
  };
}

/** 계약에 정렬 축이 없어 최신순으로 고정하고 동률을 PK로 닫는다. 결정 — 통보 270. */
export const AUDIT_EVENT_ORDER_BY: Prisma.audit_eventOrderByWithRelationInput[] =
  [{ occurred_at: "desc" }, { audit_event_id: "desc" }];

@Injectable()
export class AuditEventQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditEventQuery): Promise<PagedResponse<AuditEventView>> {
    const page = pageRequest(query);
    const where = buildAuditEventWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.audit_event.findMany({
        where,
        orderBy: AUDIT_EVENT_ORDER_BY,
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.audit_event.count({ where }),
    ]);
    return pagedResponse(rows.map(auditEventView), total, page);
  }
}
