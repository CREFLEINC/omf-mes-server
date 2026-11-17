import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AUDIT_EVENT_ORDER_BY } from '../../audit/audit-event-query.service';
import { AuditEventView, auditEventView } from '../../audit/audit-event-view';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PRODUCTION_ORDER_AUDIT_TARGET } from '../plan-proposal/proposal-audit';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 질의 — 기간은 선택이고 반개구간 `[occurredFrom, occurredTo)` 다. */
export interface ProductionOrderAuditQuery {
  occurredFrom?: string;
  occurredTo?: string;
  page?: number;
  size?: number;
}

/**
 * ERP W/O 한 건의 감사 기록 — 계획 제안 확정이 남긴 작성중 계획 대체·입고 창고 수동 변경·휴일 직접 지정.
 * 생산계획·작업지시 화면이 부른다. ⛔ 대상을 이 ERP W/O 로 고정한다 — 그 화면들은 횡단 감사 조회(`GET /audit/events`)의 권한이 없다
 * (다른 공장·다른 대상의 기록을 보지 않게). 데이터 범위는 호출자가 이미 봤다. 대상·시각 인덱스로 찾아 기간이 없어도 된다.
 */
@Injectable()
export class ProductionOrderAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(productionOrderId: number, query: ProductionOrderAuditQuery): Promise<PagedResponse<AuditEventView>> {
    const page = pageRequest(query);
    const where: Prisma.audit_eventWhereInput = {
      target_type_code: PRODUCTION_ORDER_AUDIT_TARGET,
      target_id: BigInt(productionOrderId),
      ...(query.occurredFrom === undefined && query.occurredTo === undefined
        ? {}
        : { occurred_at: { ...(query.occurredFrom === undefined ? {} : { gte: new Date(query.occurredFrom) }), ...(query.occurredTo === undefined ? {} : { lt: new Date(query.occurredTo) }) } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.audit_event.findMany({ where, orderBy: AUDIT_EVENT_ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.audit_event.count({ where }),
    ]);
    return pagedResponse(rows.map(auditEventView), total, page);
  }
}
